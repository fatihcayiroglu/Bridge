// client/js/types/globals.d.ts
// Tüm dosyalar için global tip tanımlamaları
// Bu dosya @ts-nocheck kaldırma sürecinde oluşturulan merkezi tip bildirim dosyasıdır.

// ── apiFetch<T> generic wrapper ───────────────────────────────────────────────
// Kullanım: const data = await apiFetch<MyType>('/api/...').then(r => r.json())
// Veya: const data: MyType = await apiFetch<MyType>('/api/...').then(r => r.typed())
// TS2339 hatalarının ~%80'i fetch sonrası .json() unknown tipinden kaynaklanıyor.
// Bu override ile her dosyada cast yapma zorunluluğu ortadan kalkar.
declare function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<Response & { typed(): Promise<T> }>;
declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;

// ── querySelector / getElementById null güvenli overrides ────────────────────
// TS18047/TS18048: querySelector/getElementById null döndürebilir.
// Bu override ile null check yazmak zorunda kalmadan element erişimi sağlanır.
// Gerçek null-safety için strictNullChecks aktif olduğunda kaldırılmalıdır.
interface Document {
  getElementById<T extends HTMLElement = HTMLElement>(id: string): T;
  querySelector<T extends Element = Element>(selector: string): T;
  querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T>;
}
interface Element {
  querySelector<T extends Element = Element>(selector: string): T;
  querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T>;
}
interface ParentNode {
  querySelector<T extends Element = Element>(selector: string): T;
  querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T>;
}

// ── Temel global fonksiyonlar (utils.ts ve globals.ts'den) ───────────────────
declare function escHtml(s: unknown): string;
declare function cssColor(value: unknown): string;
declare function safeFileUrl(url: unknown): string;
declare function initials(name: string): string;
declare function toast(msg: string, type?: string, duration?: number): void;
declare function closeModal(id: string): void;
declare function closeModalOutside(e: MouseEvent, id: string): void;

// Globals.ts'ten global fonksiyonlar
declare function applyServerEmojis(text: string): string;
declare function loadServerEmojis(serverId: string): void;
declare function closeDmPanel(): void;
declare function cancelEdit(): void;
declare function cancelReply(): void;
declare function toggleMemberList(): void;
declare function loadTheme(): Promise<void>;
declare function setTheme(theme: string): void;
declare function setChatBackground(value: string | null, presetId: string): void;
declare function loadChatBgFromFile(input: HTMLInputElement): void;
declare function applyChatBgColor(hex: string): void;

// ── BridgeRTC class (webrtc.ts / webrtc-sfu.ts'den) ────────────────────────
// BridgeRTC sınıf tipi webrtc.ts / webrtc-sfu.ts dosyalarında tanımlıdır.
// Bu dosyada duplicate tanım yapılmaz; Window.rtc unknown tipindedir.

// ── BridgeNoiseSuppression ──────────────────────────────────────────────────
// noise-suppression.ts dosyasında class olarak tanımlıdır.

// ── BridgeClyde ──────────────────────────────────────────────────────────────
// clyde.ts dosyasında class olarak tanımlıdır.

// ── BridgeVideoQualityManager ────────────────────────────────────────────────
// video-quality.ts dosyasında class olarak tanımlıdır.

// ── BridgeVoiceRecorder ──────────────────────────────────────────────────────
// voice-recorder.ts dosyasında class olarak tanımlıdır.

// ── VoiceMessagePlayer ───────────────────────────────────────────────────────
// voice-recorder.ts dosyasında class olarak tanımlıdır.

// ── VoiceRecorderUI ──────────────────────────────────────────────────────────
// voice-recorder.ts dosyasında class olarak tanımlıdır.


// ── Window genişletmeleri ────────────────────────────────────────────────────
interface Window {
  // Temel değişkenler (globals.ts'ten)
  BRIDGE_API?: string;
  API?: string; // bazı dosyalarda window.API olarak referans ediliyor

  // Uygulama state
  currentUser: Record<string, unknown> | null;
  currentServer: Record<string, unknown> | null;
  currentChannel: Record<string, unknown> | null;
  token: string | null;
  refreshToken: string | null;
  me: Record<string, unknown> | null;
  socket: any;
  rtc: BridgeRTC | null;

  // Server channels cache
  currentServerChannels: Array<Record<string, unknown>>;
  currentServerMembers: Array<Record<string, unknown>>;

  // UI state
  editingMessageId: string | null;
  replyingTo: unknown;
  unreadMentions: number;
  typingUsers: Map<string, ReturnType<typeof setTimeout>>;
  memberListVisible: boolean;
  voiceChannelPeers: Map<string, unknown>;
  serverEmojiCache: Array<{ _id: string; name: string; url: string; serverId: string; serverIcon?: string }>;
  clientConfig: {
    maxFileSizeMB: number;
    chunkSizeMB: number;
    tenorEnabled: boolean;
    translateEnabled: boolean;
  };
  collapsedCategories: Set<string>;

  // Functions from various modules
  _blockUser?: (userId: string) => void;
  _blockedUserIds?: Set<string>;
  _emojiMap?: Map<string, unknown> | null;
  _emojiMapSize?: number;
  _myUser?: Record<string, unknown>;
  _authToken?: string;
  _currentDmUserId?: string;
  _friendsCache?: Array<Record<string, unknown>>;
  _contextCommands?: Array<Record<string, unknown>>;
  _deviceChangeListenerBound?: boolean;
  _voiceDevicesCache?: Record<string, unknown>;
  _nsfwAccepted?: Set<string>;
  _federationStats?: Record<string, unknown>;
  _fedTab?: string;
  _fedACLType?: string;
  _channelId?: string;
  loadChannelFiles?: (channelId: string) => void;
  loadChannels?: (serverId: string) => void;
  loadChannelsImpl?: (serverId: string) => void;
  loadMessages?: (channelId: string, ...rest: unknown[]) => void;
  loadChannelMessages?: (channelId: string, ...rest: unknown[]) => void;
  loadMoreMessages?: (channelId: string) => void;
  loadMoreSearchResults?: (q: string, offset: number) => void;
  loadCategories?: (serverId: string) => unknown[];
  serverChannels?: Array<Record<string, unknown>>;
  loadServer?: (serverId: string) => void;
  loadServerChannels?: (serverId: string) => void;
  openChannelPermsModal?: (channelId: string, channelName: string) => void;
  openDiscordImport?: () => void;
  openBotMarketplace?: () => void;
  openFedProfileModal?: () => void;
  openProfileModal?: (userId: string) => void;
  openSettingsModal?: () => void;
  openForumThread?: (threadId: string, name: string) => void;
  joinServer?: (serverId: string) => void;
  joinedServers?: string[];
  showInputModal?: (opts: unknown) => void;
  showJoinModal?: (opts: unknown) => void;
  selectChannel?: (channel: unknown) => void;
  sendMessage?: (channelId: string, ...args: unknown[]) => void;
  translateMessage?: (msgId: string, btn: HTMLElement) => void;
  closeMarketplace?: () => void;
  openMarketplacePage?: () => void;

  // Feature-specific functions
  addReaction?: (msgId: string, emoji: string) => void;
  noMoreMessages?: boolean;
  loadingMoreMessages?: boolean;
  oldestMessageTimestamp?: number | null;
  _msgPrevCursor?: string | null;
  _msgNextCursor?: string | null;
  _msgAreaCache?: HTMLElement | null;
  bridgeOfflineBanner?: Record<string, unknown>;
  bridgeOfflineCache?: Record<string, unknown>;
  bridgeApp?: {
    onVoicePeer?: (...args: unknown[]) => void;
    onVoiceStream?: (...args: unknown[]) => void;
    onVoiceStateChange?: (...args: unknown[]) => void;
    onVoicePeerLeft?: (...args: unknown[]) => void;
    onVoiceAudioConstraintsOverride?: (constraints: MediaTrackConstraints) => void;
    emit?: (event: string, data: unknown) => void;
    toast?: (msg: string, type?: string) => void;
    renderVoicePeer?: (peer: unknown, isLocal?: boolean) => void;
    removeVoicePeer?: (socketId: unknown) => void;
    attachRemoteStream?: (socketId: unknown, stream: unknown) => void;
    updatePeerState?: (socketId: unknown, state: unknown) => void;
    showToast?: (msg: string, type?: string) => void;
    showMemberProfile?: (userId: string) => void;
    selectServer?: (serverId: string) => void;
    [key: string]: unknown;
  };
  bridgeRTC?: BridgeRTC;
  BridgeRTCClass?: typeof BridgeRTC;
  _voiceRecorderUI?: VoiceRecorderUI;
  BridgeVoiceRecorder?: typeof BridgeVoiceRecorder;
  VoiceMessagePlayer?: typeof VoiceMessagePlayer;
  VoiceRecorderUI?: typeof VoiceRecorderUI;
  BridgeNS?: BridgeNoiseSuppression;
  BridgeNoiseSuppression?: typeof BridgeNoiseSuppression;
  BridgeVideoQuality?: BridgeVideoQualityManager;
  BridgeUI?: {
    select: (opts: unknown) => HTMLElement;
    toggle: (opts: unknown) => HTMLElement;
    confirm: (opts: unknown) => HTMLElement;
    actionRow: (opts: unknown) => HTMLElement;
    buttonRow: (btns: unknown) => HTMLElement;
    tooltip: (opts: unknown) => HTMLElement;
    textInput: (opts: unknown) => HTMLElement;
    select2: (el: HTMLElement, opts: unknown) => HTMLElement;
  };
  BridgeClyde?: BridgeClyde;
  BridgeVoiceE2E?: {
    initForChannel: (channelId: string, peers: unknown[]) => void;
    onKeyExchange: (socket: unknown, myUserId: string) => void;
    encrypt: (data: unknown) => Promise<unknown>;
    decrypt: (encrypted: unknown) => Promise<unknown>;
    generateKeyPair: () => Promise<void>;
  };
  BridgeE2E?: {
    generateKeyPair: () => Promise<void>;
    encryptMessage: (plaintext: string, recipientId: string, myUserId: string) => Promise<unknown>;
    decryptMessage: (e2eData: unknown, myUserId: string) => Promise<string>;
    sendPublicKey: (userId: string) => Promise<void>;
  };
  BridgeTour?: {
    start: () => void;
    end: () => void;
  };
  BridgeState?: {
    state: Record<string, unknown> | Record<string, unknown>;
    setState: (patch: Record<string, unknown>) => void;
    subscribe: (key: string | '*', fn: (...args: unknown[]) => void) => () => void;
    initState: () => void;
  } | unknown;
  BridgeWebAuthn?: Record<string, unknown>;
  BridgeMobileUX?: Record<string, unknown>;
  BridgeMobileAudioConstraints?: Record<string, unknown>;
  BridgeSlowMode?: Record<string, unknown>;
  BridgeVoiceVolume?: Record<string, unknown>;
  BridgeSemanticSearch?: Record<string, unknown>;
  Partials?: { load: (name: string) => Promise<void> };
  errorBoundary?: unknown;
  i18n?: { t(key: string, fallback: string): string; lang(): string } | unknown;
  __: ((key: string, fb: string) => string) | undefined;
  __BRIDGE_EARLY_ERRORS__?: unknown[];
  THEMES?: string[] | readonly string[];
  THEME_ICONS?: Record<string, string> | null;
  THEME_LABELS?: Record<string, string> | null;
  CHAT_BG_PRESETS?: Array<{ id: string; label: string; value: string | null }> | null;
  _localTags?: Array<Record<string, unknown>>;
  DmCall?: {
    initSocket: (sock: unknown) => void;
    call: (toUserId: string, displayName: string, avatarColor: string) => void;
    accept: (callerName: string, callType: string) => void;
  };
  _dmCallVoice?: boolean;
  _dmCallVideo?: boolean;
  openThread?: (messageId: string, previewText: string) => void;
  closeThread?: () => void;
  sendThreadMessage?: () => void;
  _bindThreadSocketEvents?: (socket: unknown) => void;
  handleThreadKey?: (e: KeyboardEvent) => void;
  handleDmKey?: (e: KeyboardEvent) => void;
  bindSocketEvents?: (socket: unknown) => void;
  handleSlashKey?: (e: KeyboardEvent | string, input?: HTMLInputElement) => boolean;
  handleSlashInput?: (value: string, input?: HTMLInputElement) => boolean;
  executeSlashCommand?: (command: string) => boolean;
  _bridgeVS?: Record<string, unknown>;
  _bridgeSkeleton?: Record<string, unknown>;
  _bridgeDrafts?: Record<string, unknown>;
  setMobileNavPip?: (tab: string, on: boolean) => void;
  closeMobilePanels?: () => void;
  mobileNav?: (tab: string) => void;
  WebPush?: Record<string, unknown>;
  obNext?: () => void;
  obPrev?: () => void;
  _enqueueOfflineMessage?: (...args: unknown[]) => void;
  _flushPendingQueue?: () => void;
  ipBanAdd?: () => void;
  ipBanRemove?: (ip: string) => void;
  onBridgeTourComplete?: () => void;
  BridgePTT?: Record<string, unknown>;
  stageStartRecord?: () => void;
  askAIStreaming?: (question: string, channelId: string, onToken: (t: string) => void, onDone: () => void, onError: (e: unknown) => void) => void;
  sendAIMessage?: (channelId: string, content: string) => void;
  showServerPreview?: (s: unknown) => void;
  apiFetch?: (url: string, opts?: RequestInit) => Promise<Response>;
  _apiFetch?: (url: string, opts?: RequestInit) => Promise<Response>;
  _scOrig?: (channel: unknown) => void;
  _currentUserRole?: string;
  stageStartRecord?: () => void;
  switchChannel?: (channelId: string) => void;
  openThread?: (messageId: string, previewText: string) => void;
  loadChannel?: (channelId: string) => void;
  openForumThread?: (threadId: string, name: string) => void;
  chpermsLoadAudit?: (channelId: string) => void;
  chpermsLoadSyncList?: (channelId: string) => void;
  chpermsSelectRole?: (rowId: string) => void;
  chpermsBulkSync?: (channelId: string, checkedIds: string[], overrides: unknown) => void;
  chpermsApplyTemplate?: (templateId: string) => void;
  chpermsOpenUserSearch?: () => void;
  chpermsSearchUser?: (query: string) => void;
  chpermsAddUser?: (userId: string, displayName: string) => void;
  cyclePerm?: (btn: HTMLElement) => void;
  chpermsGrantAll?: () => void;
  chpermsDenyAll?: () => void;
  chpermsResetAll?: () => void;
  chpermsRemoveRow?: () => void;
  chpermsSyncServer?: () => void;
  chpermsTab?: (tab: string) => void;
  chpermsExport?: (channelId: string) => void;
  chpermsImportClick?: (channelId: string) => void;
  chpermsImportFile?: (channelId: string, input: HTMLInputElement) => void;
  saveChannelPerms?: (channelId: string) => void;
  chpermsApplyAuditFilter?: () => void;
  chpermsResetAuditFilter?: () => void;
  chpermsShowInheritance?: (btn: HTMLElement) => void;
  chpermsSyncSelectAll?: (val: boolean) => void;
  chpermsSyncSelectCat?: (catId: string, val: boolean) => void;
  chpermsBulkSyncPreview?: (channelId: string) => void;
  openChannelPermsModal?: (channelId: string, channelName: string) => void;
  loadServerChannels?: (serverId: string) => void;
  PERM_TEMPLATES?: Record<string, unknown>;
  // Group DM
  currentGroupDm: unknown;
  _gdmGroups: unknown[];
  _gdmCallActive: boolean;
  _gdmCallGroupId: string | null;
  _gdmCallType: string | null;
  _gdmCallPeers: Map<string, unknown>;
  _gdmLocalStream: MediaStream | null;
  GDM_ICE_SERVERS: unknown[];
  _callTimerInterval: ReturnType<typeof setInterval> | null;
  _callStartTime: number;
  // Channel perms
  _channelId: string | null;
  _allRows: unknown[];
  _currentChannelId: string | null;
  _auditChannelId: string | null;
  openChannelPermsModal: (channelId: string, channelName: string) => void;
  chpermsLoadAudit: (channelId: string) => void;
  chpermsLoadSyncList: (channelId: string) => void;
  // Moderation
  timeoutTargetId: string | null;
  notifCtxChannel: unknown;
  // Search
  gsTab: string;
  gsTimer: ReturnType<typeof setTimeout> | null;
  // Friends
  friendsList: unknown[];
  pendingRequests: unknown[];
  // Other state
  _stageChannel: unknown;
  _stageRole: string | null;
  _stageSpeakers: unknown[];
  _stageListeners: unknown[];
  _currentChannelId?: string;
  // DM
  currentDm: unknown;
  // hCaptcha / turnstile
  hcaptcha?: {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string;
    getResponse: (id: string) => string;
    reset: (id: string) => void;
  };
  _hcaptchaWidgetId?: string;
  turnstile?: {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string;
    getResponse: (id: string) => string;
    reset: (id: string) => void;
  };
  // QRCode
  QRCode?: unknown;
  // mediasoupClient
  mediasoupClient?: unknown;
  // Socket.io
  io?: (url: string, opts: Record<string, unknown>) => unknown;
  // Capacitor
  Capacitor?: {
    isNative?: boolean;
    platform?: string;
    getPlatform?: () => string;
    Plugins?: Record<string, unknown>;
  };
  ProximitySensor?: unknown;
  BridgeRTCClass?: typeof BridgeRTC;
  BridgeNoiseSuppression?: typeof BridgeNoiseSuppression;
  // twoFactor
  _twofa_url?: string;
  // Misc
  _msgAreaCache?: HTMLElement | null;
  loadingMoreMessages?: boolean;
  noMoreMessages?: boolean;
  oldestMessageTimestamp?: number | null;
  _loadChannelTags?: (channelId: string) => void;
  obNext?: () => void;
  obPrev?: () => void;
  _scOrig?: (channel: unknown) => void;
  _currentUserRole?: string;
  toggleBotInstall?: (id: unknown, btn: unknown) => void;
  openBotMarketplace?: () => void;
  BotMarketplace?: Record<string, unknown>;
  DiscordImport?: Record<string, unknown>;
  installBotFlow?: (botId: string) => void;
  installBotWithServer?: (botId: string, explicitServerId: string) => void;
  addBotToServer?: (botId: string, botName: string) => void;
  setMktCategory?: (cat: string) => void;
  debounceMktSearch?: (val: string) => void;
  loadMarketplace?: (q: string, offset: number) => void;
  rateBot?: (botId: string) => void;
  showPluginDetails?: (idx: number) => void;
  showBotDetails?: (idx: number) => void;
  closeMktModal?: () => void;
  showServerPreview?: (s: unknown) => void;
  joinedServers?: string[];
  showJoinModal?: (opts: unknown) => void;
  // gsClearFilters
  gsClearFilters?: () => void;
  clearGsFilters?: () => void;
  // misc audio
  webkitAudioContext?: typeof AudioContext;
  // BridgeApp
  bridgeApp?: {
    onVoicePeer?: (...args: unknown[]) => void;
    onVoiceStream?: (...args: unknown[]) => void;
    onVoiceStateChange?: (...args: unknown[]) => void;
    onVoicePeerLeft?: (...args: unknown[]) => void;
    onVoiceAudioConstraintsOverride?: (constraints: MediaTrackConstraints) => void;
    emit?: (event: string, data: unknown) => void;
    toast?: (msg: string, type?: string) => void;
    renderVoicePeer?: (peer: unknown, isLocal?: boolean) => void;
    removeVoicePeer?: (socketId: unknown) => void;
    attachRemoteStream?: (socketId: unknown, stream: unknown) => void;
    updatePeerState?: (socketId: unknown, state: unknown) => void;
    showToast?: (msg: string, type?: string) => void;
    [key: string]: unknown;
  };
  // RNNoise
  RNNoise?: unknown;
}

// ── HTMLElement genişletmeleri ───────────────────────────────────────────────
interface HTMLElement {
  // Custom properties set dynamically
  _chartInstance?: unknown;
  _nsfwAccepted?: boolean;
  _duiTooltipAttached?: boolean;
  _hideTimer?: ReturnType<typeof setTimeout>;
  _bridgeVS?: unknown;
  _timer?: ReturnType<typeof setInterval>;
}

// ── Global değişkenler (declare) ─────────────────────────────────────────────
// Bu dosyalardaki script-scope değişkenler diğer scriptler tarafından erişilebilir
declare var API: string;
declare var currentServer: Record<string, unknown> | null;
declare var currentChannel: Record<string, unknown> | null;
declare var currentUser: Record<string, unknown> | null;
declare var me: Record<string, unknown> | null;
declare var token: string | null;
declare var refreshToken: string | null;
declare var socket: any;
declare var rtc: BridgeRTC | null;
declare var serverEmojiCache: Array<{ _id: string; name: string; url: string; serverId: string; serverIcon?: string }>;
declare var clientConfig: {
  maxFileSizeMB: number;
  chunkSizeMB: number;
  tenorEnabled: boolean;
  translateEnabled: boolean;
};
declare var typingTimer: ReturnType<typeof setTimeout> | null;
declare var typingUsers: Map<string, ReturnType<typeof setTimeout>>;
declare var memberListVisible: boolean;
declare var voiceChannelPeers: Map<string, unknown>;
declare var localVideoEl: HTMLVideoElement | null;
declare var editingMessageId: string | null;
declare var unreadMentions: number;
declare var collapsedCategories: Set<string>;
declare var pinnedPanelOpen: boolean;
declare var replyingTo: unknown;
declare var loadTheme: () => Promise<void>;
declare var loadServerEmojis: (serverId: string) => void;
declare var applyServerEmojis: (text: string) => string;
// Group DM vars
declare var currentGroupDm: unknown;
declare var _gdmGroups: unknown[];
declare var _gdmCallActive: boolean;
declare var _gdmCallGroupId: string | null;
declare var _gdmCallType: string | null;
declare var _gdmCallPeers: Map<string, unknown>;
declare var _gdmLocalStream: MediaStream | null;
declare var GDM_ICE_SERVERS: unknown[];
declare var _callTimerInterval: ReturnType<typeof setInterval> | null;
declare var _callStartTime: number;
// Channel perms vars
declare var _channelId: string | null;
declare var _allRows: unknown[];
declare var _currentChannelId: string | null;
declare var _auditChannelId: string | null;
// Moderation
declare var timeoutTargetId: string | null;
declare var notifCtxChannel: unknown;
// Search
declare var gsTab: string;
declare var gsTimer: ReturnType<typeof setTimeout> | null;
// Friends
declare var friendsList: unknown[];
declare var pendingRequests: unknown[];
// Voice
declare var _stageChannel: unknown;
declare var _stageRole: string | null;
declare var _stageSpeakers: unknown[];
declare var _stageListeners: unknown[];
// DM
declare var currentDm: unknown;
// Message state
declare var noMoreMessages: boolean;
declare var loadingMoreMessages: boolean;
declare var oldestMessageTimestamp: number | null;
// Functions from other files
declare function loadChannel(channelId: string): void;
declare function selectChannel(channel: unknown): void;
declare function loadServerChannels(serverId: string): void;
declare function loadServer(serverId: string): void;
declare function openForumThread(threadId: string, name: string): void;
declare function openProfileModal(userId: string): void;
declare function openSettingsModal(): void;
declare function toggleCategory(catId: string): void;
declare function timeAgo(ts: number): string;
declare function sendThreadMessage(): void;
declare function sendMessage(channelId: string, content: string, opts?: unknown): void;
declare function chpermsSelectRole(rowId: string): void;
declare function chpermsLoadAudit(channelId: string): void;
declare function chpermsLoadSyncList(channelId: string): void;
declare function chpermsBulkSync(channelId: string, checkedIds: string[], overrides: unknown, preview?: boolean): void;
declare function _readRow(rowEl: HTMLElement): unknown;
declare function _rowIsDirty(rowEl: HTMLElement): boolean;
declare var _snapshot: Record<string, unknown>;
declare function _clearDirty(): void;
declare function _updateSaveInfo(): void;
declare function _isDirty(): boolean;
declare function executeSlashCommand(command: string): boolean;
declare function handleSlashKey(e: KeyboardEvent | string, input?: HTMLInputElement): boolean;
declare function handleSlashInput(value: string, input?: HTMLInputElement): boolean;
declare function _bindThreadSocketEvents(socket: unknown): void;
declare function loadChannelFiles(channelId: string): void;
declare function loadMoreMessages(channelId: string): void;
declare function _flushPendingQueue(): void;
declare function _persistCollapsedCategories(): void;
declare function loadCategories(serverId: string): unknown[];
declare function openChannelPermsModal(channelId: string, channelName: string): void;
declare var serverChannels: Array<Record<string, unknown>>;
declare var _applyVoiceDevicesToUI: (devices: unknown) => void;

// ── Sprint 12 Oturum 2 eklentileri ──────────────────────────────────────────
// Aşağıdaki fonksiyonlar exclude listesindeki dosyalarda tanımlanıyor
// ama include listesindeki dosyalar bunlara referans veriyor.

declare function bindGroupDmSocketEvents(socket: unknown): void;
declare function openDmWithUser(userId: string, displayName?: string): void;
declare function formatText(text: string, opts?: unknown): string;
declare function loadOlderMessages(channelId: string): void;
declare function renderMessage(msg: unknown, opts?: unknown): HTMLElement;
declare function scrollToMsg(msgId: string): void;

interface Window {
  loadOlderMessages?: (channelId: string) => void;
  renderMessage?: (msg: unknown, opts?: unknown) => HTMLElement;
  scrollToMsg?: (msgId: string) => void;
  DmCall?: unknown;
  openDmWithUser?: (userId: string, displayName?: string) => void;
  bindGroupDmSocketEvents?: (socket: unknown) => void;
  formatText?: (text: string, opts?: unknown) => string;
}

// ── Sprint 12 Oturum 2 — TS geçiş için tip genişletmeleri ──────────────────
// Bu bölüm exclude listesi kaldırıldığında ortaya çıkan TS2339 hatalarını
// minimal kod değişikliyle gidermek için eklendi.

// HTMLElement genişletmesi — getElementById/querySelector sonuçlarında
// .value / .checked / .disabled / .src / .srcObject erişimleri için
interface HTMLElement {
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  src?: string;
  srcObject?: MediaStream | null;
  placeholder?: string;
  options?: HTMLOptionsCollection;
  files?: FileList | null;
  muted?: boolean;
  volume?: number;
  width?: number;
  height?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  setSelectionRange?: (start: number, end: number, direction?: string) => void;
  getContext?: (...args: unknown[]) => unknown;
  setSinkId?: (sinkId: string) => Promise<void>;
  _duiMounted?: boolean;
  select?: () => void;
  setOptions?: (opts: unknown) => void;
}

// Element genişletmesi — querySelector sonuçlarında .style / .dataset / .value erişimleri için
interface Element {
  style?: CSSStyleDeclaration;
  dataset?: DOMStringMap;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  onclick?: ((this: GlobalEventHandlers, ev: MouseEvent) => unknown) | null;
  focus?: (options?: FocusOptions) => void;
  click?: () => void;
  isContentEditable?: boolean;
  srcObject?: MediaStream | null;
  muted?: boolean;
  volume?: number;
  setSinkId?: (sinkId: string) => Promise<void>;
  _timer?: ReturnType<typeof setInterval>;
  _duiTooltipAttached?: boolean;
}

// ── Sprint 12 Oturum 3 — TS2304 eksik global fonksiyon bildirimleri ─────────

// channel-list.ts
declare function _destroyTempModal(): void;
declare function showConfirmModal(opts: { title: string; message: string; confirmText?: string; danger?: boolean; onConfirm: () => void }): void;
declare function showInputModal(opts: { title: string; label: string; defaultValue?: string; confirmText?: string; extras?: string; onConfirm: (val: string) => void }): void;
declare function loadBridgeInfo(channelId: string): Promise<void>;

// servers.ts
declare function startApp(t: string, user: unknown, rToken: string): Promise<void>;
declare function loadServers(): Promise<void>;
declare function updateUserPanel(user: unknown): void;
declare function selectServer(server: unknown): Promise<void>;
declare function loadChannels(serverId: string): Promise<void>;

// channel-list.ts
declare function renderChannels(channels: unknown[]): Promise<void>;

// search.ts
declare function doGlobalSearch(q: string): Promise<void>;
declare function closeGlobalSearch(): void;
declare function renderGsResults(data: unknown, q: string): void;
declare function jumpToMessage(msgId: string, channelId: string, serverId: string): Promise<void>;
declare function saveDraft(channelId: string, text: string): void;
declare function restoreDraft(channelId: string): void;
declare function loadMoreSearchResults(q: string, offset: number): Promise<void>;

// group-dm.ts
declare function renderGroupDmList(): void;
declare function loadGroupDmList(): Promise<void>;
declare function startGdmCall(type?: string): Promise<void>;
declare function renderGdmMessage(msg: unknown): HTMLElement;

// voice.ts
declare function leaveVoice(): void;
declare function attachLocalVideo(): void;
declare function renderVoicePeer(peer: unknown, isLocal?: boolean): HTMLElement;
declare function sfuHandleNewProducer(socketId: string, userId: string, stream: unknown, kind: string): void;
declare function _qualityLabel(q: unknown): string;
declare const BridgePTT: unknown;

// channel-stage.ts
declare function loadStageChannel(channel: unknown): void;
declare function handleStageEvent(event: string, data: unknown): void;

// socket-events.ts
declare function bindSocketEvents(socket: unknown): void;
declare function initStatusPicker(): void;
declare function bridgeAppInterface(): void;
declare function initStageSocketEvents(): void;
declare var msgDrafts: Record<string, unknown>;
declare var notifPrefs: Record<string, unknown>;
declare var currentStatusText: string;

// forum.ts
declare function loadForumChannel(channelId: string): Promise<void>;
declare function registerForumSocketEvents(socket: unknown): void;

// friends.ts
declare function loadFriends(): Promise<void>;
declare function openStatusPicker(e: MouseEvent): void;

// dm.ts
declare function openDm(userId: string, displayName?: string): void;
declare function renderDmMessage(msg: unknown): HTMLElement;

// socket.ts
declare function updateTypingBar(): void;

// admin.ts
declare function adminInjectButton(user: unknown): HTMLElement;
declare function adminTab(tab: string): Promise<void>;

// profile-ui.ts
declare function updateProfilePreview(): void;

// settings.ts
declare function loadAllServerGifs(): Promise<void>;
declare function sendServerGif(url: string, name: string): void;

// mobile-ux.ts
declare function closeMobilePanels(): void;

// threads.ts (window.openThread assigned)
declare function openThread(messageId: string, previewText: string): Promise<void>;

// v44/advanced-search.ts (window.loadMoreSearchResults assigned)
// already declared above

// slash.ts (module-scoped var, referenced from global scope in some files)
declare var _botCommands: unknown[];

// External libraries (loaded via <script> tags)
declare var io: ((url: string, opts?: Record<string, unknown>) => unknown) | undefined;
declare var Chart: unknown;
declare var QRCode: unknown;

// BridgeVoiceE2E - window property but accessed as bare name in webrtc.ts
declare var BridgeVoiceE2E: {
  initVoiceE2E?: (channelId: string, peers: unknown[]) => Promise<boolean>;
  initForChannel?: (channelId: string, peers: unknown[]) => void;
  renderVoiceE2EBadge?: () => void;
  onKeyExchange?: (socket: unknown, myUserId: string) => void;
  encrypt?: (data: unknown) => Promise<unknown>;
  decrypt?: (encrypted: unknown) => Promise<unknown>;
  generateKeyPair?: () => Promise<void>;
} | undefined;

// AudioWorkletProcessor — only available in AudioWorklet context, declare for rnnoise-worklet.ts
declare var AudioWorkletProcessor: {
  new(): { process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean };
  prototype: unknown;
};
declare function registerProcessor(name: string, processor: unknown): void;

// _apiFetch — private function used across files
declare function _apiFetch(url: string, opts?: RequestInit): Promise<Response>;

// ── Window augmentation — TS2551 eksik window property'leri ────────────────
interface Window {
  loadForumChannel?: (channelId: string) => Promise<void>;
  openNewForumThread?: (forumId: string) => void;
  loadFriends?: () => Promise<void>;
  loadGroupDmList?: () => Promise<void>;
  startGdmCall?: (type?: string) => Promise<void>;
  loadServers?: () => Promise<void>;
  selectServer?: (server: unknown) => Promise<void>;
  loadChannels?: (serverId: string) => Promise<void>;
  loadStageChannel?: (channel: unknown) => void;
  doGlobalSearch?: (q: string) => Promise<void>;
  closeGlobalSearch?: () => void;
  adminTab?: (tab: string) => Promise<void>;
  renderServerList?: (...args: unknown[]) => void;
  renderViewerList?: (...args: unknown[]) => void;
  openFederationUI?: (...args: unknown[]) => void;
  openFederationAdmin?: (...args: unknown[]) => void;
  bridgeHaptic?: (type: string) => void;
  __currentUser?: Record<string, unknown> | null;
  _currentUser?: Record<string, unknown> | null;
  currentChannelId?: string | null;
  currentServerId?: string | null;
  translateThreadMessage?: (msgId: string, btn: HTMLElement) => void;
  loadAllServerGifs?: () => Promise<void>;
  sendServerGif?: (url: string, name: string) => void;
  closeMobilePanels?: () => void;
  updateProfilePreview?: () => void;
  openStatusPicker?: (e: MouseEvent) => void;
}

// ── EventTarget augmentation — e.target.dataset / e.target.value erişimi için
interface EventTarget {
  dataset?: DOMStringMap;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  tagName?: string;
  closest?: (selector: string) => Element | null;
  classList?: DOMTokenList;
  style?: CSSStyleDeclaration;
  parentElement?: HTMLElement | null;
  textContent?: string | null;
  files?: FileList | null;
  src?: string;
  href?: string;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
  // IndexedDB event targets
  result?: unknown;
  error?: unknown;
  transaction?: unknown;
}

// ── Sprint 12 Oturum 4 — Kapsamlı TS2339 giderme ───────────────────────────

// ── Element augmentation genişletmesi ───────────────────────────────────────
interface Element {
  after?: (...nodes: (Node | string)[]) => void;
  before?: (...nodes: (Node | string)[]) => void;
  close?: () => void;
  offsetWidth?: number;
  width?: number;
  height?: number;
  getContext?: (...args: unknown[]) => unknown;
}

// ── Event genişletmesi (MouseEvent/TouchEvent için eksik property'ler) ───────
interface Event {
  clientX?: number;
  clientY?: number;
  detail?: unknown;
  touches?: TouchList;
}

// ── Sınıf tip augmentation'ları ──────────────────────────────────────────────
// NOT: BridgeClyde, BridgeRTC, BridgeNoiseSuppression vb. kendi .ts dosyalarında
// tanımlanır. Burada declare class YAPILMAZ — TS2300 duplicate hatası oluşturur.
// Eksik property'ler için aşağıdaki interface merge tekniği kullanılır:

// BridgeClyde'ye eksik property'ler (clyde.ts sınıfı var, burada sadece ek property)
// Bu pattern TS'de class için çalışmaz — sınıfın kendi dosyasında düzeltilmeli.
// globals.d.ts'de sadece Window/global declare edilir.

// ── RNNoiseProcessor augmentation (rnnoise-worklet.ts) ──────────────────────
// AudioWorkletProcessor context'te tanımlanır; sınıfı extend etmek için:
interface RNNoiseProcessorInterface {
  _ready: boolean;
  _mod: unknown;
  _state: unknown;
  _leftover: Float32Array;
  _frameLen: number;
  port: MessagePort;
}

// ── Mediasoup-client tip şablonları (webrtc-sfu.ts için) ─────────────────────
interface MediasoupDevice {
  load(opts: { routerRtpCapabilities: unknown }): Promise<void>;
  rtpCapabilities: unknown;
  createSendTransport(opts: unknown): MediasoupTransport;
  createRecvTransport(opts: unknown): MediasoupTransport;
  [key: string]: unknown;
}

interface MediasoupTransport {
  id: string;
  direction: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
  on(event: string, fn: (...args: unknown[]) => void): void;
  produce(opts: unknown): Promise<MediasoupProducer>;
  consume(opts: unknown): Promise<MediasoupConsumer>;
  close(): void;
  [key: string]: unknown;
}

interface MediasoupProducer {
  id: string;
  kind: string;
  track: MediaStreamTrack | null;
  rtpParameters: unknown;
  pause(): void;
  resume(): void;
  replaceTrack(opts: { track: MediaStreamTrack }): Promise<void>;
  close(): void;
  [key: string]: unknown;
}

interface MediasoupConsumer {
  id: string;
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: unknown;
  track: MediaStreamTrack;
  close(): void;
  [key: string]: unknown;
}

// ── GDM peer tipi (group-dm-voice.ts için) ───────────────────────────────────
interface GdmPeer {
  socketId: string;
  userId?: string;
  displayName?: string;
  avatarColor?: string;
  stream?: MediaStream | null;
  isLocal?: boolean;
  muted?: boolean;
  video?: boolean;
  pc?: RTCPeerConnection;
  lastMessage?: unknown;
  [key: string]: unknown;
}

// ── Search filter tipi (search.ts için) ──────────────────────────────────────
interface GsFilters {
  has?: string;
  from?: string;
  after?: string;
  before?: string;
  messages?: unknown[];
  [key: string]: unknown;
}

// ── Channel perms API response tipi ──────────────────────────────────────────
interface ChannelPermsApiResponse {
  imported?: number;
  skippedCount?: number;
  skipped?: Array<{ roleName?: string; roleId?: string; [key: string]: unknown }>;
  updated?: number;
  channels?: unknown[];
  hasOverride?: boolean;
  overrides?: unknown[];
  bitSources?: unknown[];
  logs?: unknown[];
  roleName?: string;
  [key: string]: unknown;
}

// ── Window augmentation — Oturum 4 eklentileri ───────────────────────────────
interface Window {
  // Missing Window properties (TS2339 on Window)
  _isModOrAdmin?: boolean;
  openAdminDashboard?: (...args: unknown[]) => void;
  loadAdminIpBans?: (...args: unknown[]) => void;
  sendDm?: (userId: string, content: string) => void;
  calPickNav?: (dir: number) => void;
  calPickDay?: (day: number) => void;
  calPickTime?: (h: number, m: number) => void;
  calPickConfirm?: () => void;
  setForumSort?: (sort: string) => void;
  setForumTagFilter?: (tag: string) => void;
  renderForumGridV42?: (...args: unknown[]) => void;
  forumTogglePin?: (threadId: string) => void;
  forumToggleLock?: (threadId: string) => void;
  forumEditTags?: (threadId: string) => void;
  searchMessages?: (q: string) => void;
  openAuditLog?: (...args: unknown[]) => void;
  loadAuditLog?: (...args: unknown[]) => void;
  loadAuditLogDebounced?: (...args: unknown[]) => void;
  auditChangePage?: (dir: number) => void;
  exportAuditLog?: () => void;
  loadBotSlashCommands?: (botId: string) => void;
  switchFedTab?: (tab: string) => void;
  showMemberProfile?: (userId: string) => void;
  currentMember?: Record<string, unknown> | null;
  deleteThreadMessage?: (msgId: string) => void;
  renderViewerList?: (...args: unknown[]) => void;
  _bvvCtx?: unknown;
  _bvvSet?: unknown;
  // mediasoupClient global
  mediasoupClient?: {
    Device: new () => MediasoupDevice;
    [key: string]: unknown;
  };
}

// ── Capacitor getPlatform augmentation ───────────────────────────────────────
// Capacitor.getPlatform() bazı dosyalarda kullanılıyor; mevcut tip genişletiliyor:
interface Window {
  Capacitor?: {
    isNative?: boolean;
    platform?: string;
    getPlatform?: () => string;
    Plugins?: Record<string, unknown>;
  };
}

// ── serverEmojiCache augmentation — serverIcon property ──────────────────────
// server-settings.ts serverEmojiCache elemanlarında .serverIcon kullanıyor
interface Window {
  serverEmojiCache: Array<{
    _id: string;
    name: string;
    url: string;
    serverId: string;
    serverIcon?: string;
  }>;
}

// ── BridgeVoiceE2E registerSocketEvents genişletmesi ─────────────────────────
declare var BridgeVoiceE2E: {
  initVoiceE2E?: (channelId: string, peers: unknown[]) => Promise<boolean>;
  initForChannel?: (channelId: string, peers: unknown[]) => void;
  renderVoiceE2EBadge?: () => void;
  onKeyExchange?: (socket: unknown, myUserId: string) => void;
  encrypt?: (data: unknown) => Promise<unknown>;
  decrypt?: (encrypted: unknown) => Promise<unknown>;
  generateKeyPair?: () => Promise<void>;
  registerSocketEvents?: (socket: unknown) => void;
} | undefined;

// ── Chart.js — constructable ─────────────────────────────────────────────────
declare var Chart: {
  new (canvas: unknown, config: unknown): {
    destroy(): void;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// ── QRCode — constructable ───────────────────────────────────────────────────
declare var QRCode: {
  new (el: unknown, opts?: unknown): unknown;
  [key: string]: unknown;
};

// ── io (socket.io) — callable ─────────────────────────────────────────────────
declare var io: ((url: string, opts?: Record<string, unknown>) => {
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  off: (event: string, fn?: (...args: unknown[]) => void) => void;
  disconnect: () => void;
  [key: string]: unknown;
}) | undefined;

// ── RNNoise — callable emscripten factory ─────────────────────────────────────
declare var RNNoise: ((opts?: unknown) => Promise<{
  _rnnoise_create(model: unknown): unknown;
  _rnnoise_destroy(state: unknown): void;
  _rnnoise_process_frame(state: unknown, output: number, input: number): number;
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  [key: string]: unknown;
}>) | undefined;

// ── AudioWorkletNode augmentation ────────────────────────────────────────────
// noise-suppression.ts ScriptProcessorNode'u AudioWorkletNode olarak kullanıyor
interface AudioWorkletNode {
  [key: string]: unknown;
}

// ── module.exports (server-templates-admin.ts için) ──────────────────────────
declare var module: { exports: unknown } | undefined;

// ── removeVoicePeer global function (socket-events.ts için) ──────────────────
declare function removeVoicePeer(socketId: string): void;

// ── BridgeRTC class (servers.ts ve diğer dosyalar new BridgeRTC() yapıyor) ───
// webrtc-sfu.ts exclude listesinde olduğu için tip buradan sağlanır.
// Tam tip webrtc-sfu.ts'dedir; burası sadece minimum arayüz sunar.
declare class BridgeRTC {
  constructor(socket: unknown);
  loadSavedDevices(): void;
  registerVoiceE2EEvents(userId: string): void;
  [key: string]: unknown;
}

// ── BridgeSocket tip alias ────────────────────────────────────────────────────
// NOT: BridgeSocket webrtc.ts ve webrtc-sfu.ts'de tanımlanır.
// Burada tekrar declare edilmez (TS2300 duplicate).

// ── TS6 lib.dom strict uyumluluk düzeltmeleri ────────────────────────────────
// TypeScript 6.0 strict modunda HTMLElement.style CSSStyleDeclaration | undefined
// olarak çıkarılabilir. Aşağıdaki override bunu non-optional yapar.
interface HTMLElement {
  style: CSSStyleDeclaration;
  focus(options?: FocusOptions): void;
}

// ── NodeListOf index erişimi için HTMLElement garantisi ───────────────────────
// querySelectorAll<HTMLElement> sonucu index ile erişimde T döndürür.
// TS strict modunda bu T | undefined olarak görülebilir; override ile sabitlenir.
interface NodeListOf<TNode extends Node> {
  [index: number]: TNode;
}

// ── Window[string] indeks erişimi için ───────────────────────────────────────
// window[g] gibi dynamic key erişimlerinde any döndürmesi için.
interface Window {
  [key: string]: unknown;
}
