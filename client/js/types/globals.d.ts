// client/js/types/globals.d.ts
// Global tip tanımlamaları — @ts-nocheck kaldırma sürecinde oluşturuldu.
//
// Sprint 31 değişiklikleri:
//   - utils.ts'ten gelen fonksiyonlar (escHtml, toast, closeModal vb.) kaldırıldı
//     → artık import ile erişiliyor: import { escHtml } from './utils.ts'
//   - theme.ts'ten gelen THEMES/THEME_ICONS/THEME_LABELS/CHAT_BG_PRESETS kaldırıldı
//     → artık import ile erişiliyor: import { THEMES } from './theme.ts'
//   - globals.ts'ten gelen applyServerEmojis, loadServerEmojis vb. kaldırıldı
//     → artık import ile erişiliyor
//   - Window.THEMES / Window.THEME_ICONS / Window.CHAT_BG_PRESETS kaldırıldı
//   - Kalan declare'lar Sprint 81+ hedefi: tüketiciler import'a geçince temizlenecek

// ── apiFetch<T> generic wrapper ───────────────────────────────────────────────
declare function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<Response & { typed(): Promise<T> }>;
declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;

// ── Global fonksiyon declare'ları (Sprint 38: temizlendi) ──────────────────────
// closeDmPanel, cancelEdit, cancelReply, toggleMemberList
// → ilgili modüller import/export'a geçti; bu declare'lar artık gerekmiyor.

// ── BridgeRTC / class tanımları ───────────────────────────────────────────────
// Sınıf tipleri kendi dosyalarında tanımlıdır; burada duplicate edilmez.


interface BridgeDesktopUpdateState {
  phase:
    | 'idle'
    | 'disabled'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseName: string | null;
  percent: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  canInstall: boolean;
  isPackaged: boolean;
}

interface BridgeDesktopUpdaterAPI {
  getStatus(): Promise<BridgeDesktopUpdateState>;
  check(): Promise<BridgeDesktopUpdateState>;
  install(): Promise<BridgeDesktopUpdateState>;
  onStatus(cb: (data: BridgeDesktopUpdateState) => void): (() => void) | void;
}

// ── Window genişletmeleri ─────────────────────────────────────────────────────
interface Window {
  // Config (sunucu tarafından enjekte edilir)
  BRIDGE_API?: string;
  API?: string;       // Köprü — window.BRIDGE_API tercih edilmeli, bu kaldırılacak
  BRIDGE_DEV?: boolean;
  BRIDGE_APP_VERSION?: string;
  BRIDGE_ENV?: string;
  BRIDGE_SENTRY_DSN?: string;

  // BridgeRegistry — ESM import'a geçince kaldırılacak (Sprint 81 açık maddesi)
  BridgeRegistry?: {
    register(key: string, fn: (...args: unknown[]) => unknown): void;
    get(key: string): unknown;
    call(key: string, ...args: unknown[]): unknown;
  };

  // Web Push köprüsü — web-push.ts tarafından set edilir
  __bridgePushEnabled?: boolean;

  // Error boundary — Sprint 31 köprüsü
  errorBoundary: {
    report(error: unknown, context?: string): void;
    crash(error: unknown, context?: string): void;
    wrap<T extends unknown[], R>(fn: (...args: T) => R, context?: string): (...args: T) => R | undefined;
  };

  // External SDK — kaçınılmaz, her sprint kalır
  hcaptcha?: {
    render(container: string | HTMLElement, params: Record<string, unknown>): string;
    getResponse(id?: string): string;
    reset(id?: string): void;
  };
  turnstile?: {
    render(container: string | HTMLElement, params: Record<string, unknown>): string;
    reset(): void;
  };
  Sentry?: {
    init(opts: Record<string, unknown>): void;
    captureException(e: unknown): void;
    captureMessage(msg: string, level?: string): void;
    setUser(user: Record<string, unknown> | null): void;
    setTag(key: string, value: string): void;
    withScope(fn: (scope: unknown) => void): void;
    addBreadcrumb(opts: Record<string, unknown>): void;
  };
  Capacitor?: {
    isNativePlatform?(): boolean;
    getPlatform?(): string;
    Plugins?: Record<string, unknown>;
  };

  // İç modüller — Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır
  sentryClient?: { setSentryUser(user: Record<string, unknown> | null): void };
  i18n?: { t(key: string, fallback: string): string; lang?(): string };
  bridgeOfflineBanner?: unknown;
  bridgeOfflineCache?: { upsertMessage(channelId: string, msg: Record<string, unknown>): Promise<void> };
  _bridgeOfflineQueue?: unknown;
  _bridgeSkeleton?: unknown;
  _bridgeDebug?: boolean;
  __BRIDGE_EARLY_ERRORS__?: unknown[];
  __SENTRY_INITIALIZED__?: boolean;
  _hcaptchaWidgetId?: string;

  // Socket ve state köprüsü — Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır
  socket?: unknown;
  rtc?: unknown;
  me?: unknown;
  refreshToken?: string | null;
  currentDm?: unknown;
  currentServerChannels?: Array<Record<string, unknown>>;
  currentServerMembers?: Array<Record<string, unknown>>;
  currentMember?: unknown;
  currentServerId?: string;
  currentChannelId?: string;
  editingMessageId?: string | null;
  replyingTo?: unknown;
  unreadMentions?: number;
  typingUsers?: Map<string, ReturnType<typeof setTimeout>>;
  memberListVisible?: boolean;
  voiceChannelPeers?: Map<string, unknown>;
  pinnedPanelOpen?: boolean;
  joinedServers?: Array<Record<string, unknown>>;
  loadingMoreMessages?: boolean;
  noMoreMessages?: boolean;
  oldestMessageTimestamp?: number;
  _msgNextCursor?: string | null;
  _msgPrevCursor?: string | null;
  _currentDmUserId?: string | null;
  _currentUser?: unknown;
  _authToken?: string | null;
  _blockedUserIds?: Set<string>;
  _nsfwAccepted?: Set<string>;
  _friendsCache?: unknown[];
  _contextCommands?: Array<{ type: string; name: string; [k: string]: unknown }>;
  _federationStats?: unknown;
  _chpermsState?: unknown;
  _emojiMap?: Map<string, unknown> | null;
  _emojiMapSize?: number;
  _voiceRecorderUI?: unknown;
  _bridgeVS?: unknown;
  _bvvCtx?: unknown;
  _bvvSet?: unknown;
  _stageChannel?: unknown;
  _twofa_url?: string;
  _saveChannelScroll?: (id: string, pos: number) => void;
  _isModOrAdmin?: boolean;
  _currentUserRole?: unknown;
  _deviceChangeListenerBound?: boolean;
  _bridgeStartLocalVAD?: () => void;
  _bridgeStopLocalVAD?: () => void;
  _bridgeVADCleanup?: () => void;
  _bridgeVoiceActivityUI?: unknown;
  _dmCallVoice?: (...args: unknown[]) => void;
  _dmCallVideo?: (...args: unknown[]) => void;
  _voiceDevicesCache?: unknown;
  _bridgeDrafts?: Record<string, string>;
  bridgeApp?: unknown;
  bridgeRTC?: unknown;
  bridgeHaptic?: unknown;
  mobileNav?: (...args: unknown[]) => unknown;
  setMobileNavPip?: (...args: unknown[]) => void;

  // Global fonksiyonlar — Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır
  sendMessage?: (...args: unknown[]) => void;
  renderMessage?: (...args: unknown[]) => string;
  renderMessageContent?: (...args: unknown[]) => string;
  renderMessageMenu?: (...args: unknown[]) => string;
  loadChannelMessages?: (...args: unknown[]) => void;
  loadMessages?: (...args: unknown[]) => void;
  loadMoreMessages?: (...args: unknown[]) => void;
  loadOlderMessages?: (...args: unknown[]) => void;
  loadChannelsImpl?: (...args: unknown[]) => void;
  selectServer?: (...args: unknown[]) => void;
  selectChannel?: (...args: unknown[]) => void;
  switchChannel?: (...args: unknown[]) => void;
  reloadServerList?: (...args: unknown[]) => void;
  renderServerList?: (...args: unknown[]) => void;
  showMemberProfile?: (...args: unknown[]) => void;
  showJoinModal?: (...args: unknown[]) => void;
  initInfiniteScroll?: (...args: unknown[]) => void;
  scrollToMsg?: (...args: unknown[]) => void;
  addReaction?: (...args: unknown[]) => void;
  sendDm?: (...args: unknown[]) => void;
  searchMessages?: (...args: unknown[]) => void;
  doGlobalSearch?: (...args: unknown[]) => void;
  loadMarketplace?: (...args: unknown[]) => void;
  loadForumChannel?: (...args: unknown[]) => void;
  askAIStreaming?: (...args: unknown[]) => void;
  sendAIMessage?: (...args: unknown[]) => void;
  handleThreadKey?: (...args: unknown[]) => void;
  sendThreadMessage?: (...args: unknown[]) => void;
  deleteThreadMessage?: (...args: unknown[]) => void;
  translateThreadMessage?: (...args: unknown[]) => void;
  _bindThreadSocketEvents?: (...args: unknown[]) => void;
  saveDraft?: (...args: unknown[]) => void;
  restoreDraft?: (...args: unknown[]) => void;
  adminTab?: (...args: unknown[]) => void;
  serverControl?: (...args: unknown[]) => void;
  bridgeUpdater?: BridgeDesktopUpdaterAPI;
  obNext?: (...args: unknown[]) => void;
  obPrev?: (...args: unknown[]) => void;
  onBridgeTourComplete?: (...args: unknown[]) => void;
  onDiscoverMount?: (...args: unknown[]) => void;
  onDiscoverUnmount?: (...args: unknown[]) => void;
  joinServerFromDiscover?: (...args: unknown[]) => void;
  initDiscover?: (...args: unknown[]) => void;
  showServerPreview?: (...args: unknown[]) => void;
  renderGsResults?: (...args: unknown[]) => void;
  clearGsFilters?: (...args: unknown[]) => void;
  injectBadgesIntoProfileCard?: (...args: unknown[]) => void;
  injectSocialIntoProfileCard?: (...args: unknown[]) => void;
  renderUserBadges?: (...args: unknown[]) => void;
  renderUserProfileSocial?: (...args: unknown[]) => void;
  loadMyBadgesSettings?: (...args: unknown[]) => void;
  adminAwardBadge?: (...args: unknown[]) => void;
  adminRevokeBadge?: (...args: unknown[]) => void;
  loadAdminBadgePanel?: (...args: unknown[]) => void;
  loadBotSlashCommands?: (...args: unknown[]) => void;
  addBotToServer?: (...args: unknown[]) => void;
  installBotFlow?: (...args: unknown[]) => void;
  installBotWithServer?: (...args: unknown[]) => void;
  rateBot?: (...args: unknown[]) => void;
  showBotDetails?: (...args: unknown[]) => void;
  toggleBotInstall?: (...args: unknown[]) => void;
  showPluginDetails?: (...args: unknown[]) => void;
  debounceMktSearch?: (...args: unknown[]) => void;
  setMktCategory?: (...args: unknown[]) => void;
  switchFedTab?: (...args: unknown[]) => void;
  decryptIncoming?: (...args: unknown[]) => void;
  sendBoost?: (...args: unknown[]) => void;
  saveChannelPerms?: (...args: unknown[]) => void;
  cyclePerm?: (...args: unknown[]) => void;
  chpermsTab?: (...args: unknown[]) => void;
  chpermsAddUser?: (...args: unknown[]) => void;
  chpermsSelectRole?: (...args: unknown[]) => void;
  chpermsRemoveRow?: (...args: unknown[]) => void;
  chpermsGrantAll?: (...args: unknown[]) => void;
  chpermsDenyAll?: (...args: unknown[]) => void;
  chpermsResetAll?: (...args: unknown[]) => void;
  chpermsLoadAudit?: (...args: unknown[]) => void;
  chpermsApplyAuditFilter?: (...args: unknown[]) => void;
  chpermsResetAuditFilter?: (...args: unknown[]) => void;
  chpermsApplyTemplate?: (...args: unknown[]) => void;
  chpermsOpenUserSearch?: (...args: unknown[]) => void;
  chpermsSearchUser?: (...args: unknown[]) => void;
  chpermsLoadSyncList?: (...args: unknown[]) => void;
  chpermsSyncSelectAll?: (...args: unknown[]) => void;
  chpermsSyncSelectCat?: (...args: unknown[]) => void;
  chpermsSyncServer?: (...args: unknown[]) => void;
  chpermsBulkSync?: (...args: unknown[]) => void;
  chpermsBulkSyncPreview?: (...args: unknown[]) => void;
  chpermsExport?: (...args: unknown[]) => void;
  chpermsImportClick?: (...args: unknown[]) => void;
  chpermsImportFile?: (...args: unknown[]) => void;
  chpermsShowInheritance?: (...args: unknown[]) => void;
  _chpermsBuildMatrix?: (...args: unknown[]) => void;
  _chpermsBuildRow?: (...args: unknown[]) => void;
  _chpermsMarkDirty?: (...args: unknown[]) => void;
  _chpermsClearDirty?: (...args: unknown[]) => void;
  _chpermsRowIsDirty?: (...args: unknown[]) => void;
  _chpermsReadRow?: (...args: unknown[]) => void;
  _chpermsSetCurrentChannelId?: (...args: unknown[]) => void;
  _chpermsUpdateSaveInfo?: (...args: unknown[]) => void;
  ipBanAdd?: (...args: unknown[]) => void;
  ipBanRemove?: (...args: unknown[]) => void;
  calPickDay?: (...args: unknown[]) => void;
  calPickNav?: (...args: unknown[]) => void;
  calPickTime?: (...args: unknown[]) => void;
  calPickConfirm?: (...args: unknown[]) => void;
  loadMoreSearchResults?: (...args: unknown[]) => void;
  loadAuditLog?: (page?: number) => void;
  exportAuditLog?: (...args: unknown[]) => void;
  BridgeSemanticSearch?: { open: (...args: unknown[]) => void };

  // Namespace sınıfları — Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır
  BridgeNS?: unknown;
  BridgeUI?: unknown;
  BridgeE2E?: unknown;
  BridgeVoiceE2E?: unknown;
  BridgeNoiseSuppression?: unknown;
  BridgeVideoQuality?: unknown;
  BridgeVoiceRecorder?: unknown;
  BridgeMobileUX?: unknown;
  BridgeMobileAudioConstraints?: unknown;
  BridgePTT?: unknown;
  BridgeTour?: unknown;
  BridgeClyde?: unknown;
  BridgeWebAuthn?: unknown;
  CanvasUI?: unknown;
  DiscordImport?: unknown;
  DmCall?: unknown;
  DmRead?: unknown;
  ScheduledUI?: unknown;
  TranslateBtn?: unknown;
  VoiceActivityUI?: unknown;
  VoiceMessagePlayer?: unknown;
  VoiceRecorderUI?: unknown;
  WebPush?: unknown;
  BotMarketplace?: unknown;
  BridgeAPI?: unknown;
  Partials?: unknown;


  // ── Sprint 81: loadFriends + handleStageEvent köprüleri kaldırıldı ──────────
  // socket-events.ts artık import { loadFriends } from './friends.ts' ve
  // import { handleStageEvent } from './channel-stage.ts' kullanıyor.
  clientConfig?: Record<string, unknown>;

  // Sabitler — Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır
  PERM_TEMPLATES?: unknown;
  THEMES?: string[];
  THEME_ICONS?: Record<string, string>;
  THEME_LABELS?: Record<string, string>;
  CHAT_BG_PRESETS?: unknown[];
}
