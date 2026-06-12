// server/socket/contracts.ts
// Socket.IO olay sözleşmeleri — Session 9 güncellemesi
// Canvas (draw, clear), DM okuma (read_receipt) ve Ses (voice_activity) tiplerini genişletir.

// ─────────────────────────────────────────────────────────────
// Yardımcı / paylaşılan tipler
// ─────────────────────────────────────────────────────────────

/** Canvas stroke araçları */
export type CanvasTool = 'pen' | 'eraser' | 'line' | 'rect' | 'circle' | 'text';

/** Tek bir koordinat noktası */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** Canvas stroke — tüm çizim verisi */
export interface CanvasStroke {
  id:          string;
  tool:        CanvasTool;
  /** Renk: #rrggbb veya #rrggbbaa */
  color:       string;
  /** Çizgi kalınlığı 1–40 */
  size:        number;
  /** Geriye dönük uyumluluk — size ile aynı anlama gelir */
  width:       number;
  points:      CanvasPoint[];
  /** tool === 'text' ise metin içeriği */
  text?:       string;
  userId:      string;
  displayName: string;
  ts:          number;
}

/** Canvas çizimi için istemciden gönderilen stroke verisi (x, y, color, size zorunlu) */
export interface CanvasDrawPayload {
  /** Başlangıç x koordinatı (nokta veya çizgi başlangıcı) */
  x:     number;
  /** Başlangıç y koordinatı */
  y:     number;
  /** Renk hex kodu — örn. #ff0000 */
  color: string;
  /** Fırça/kalem boyutu (piksel) */
  size:  number;
  /** Tam stroke nesnesi */
  stroke: Omit<CanvasStroke, 'userId' | 'displayName' | 'ts'>;
}

/** Canvas temizleme payload */
export interface CanvasClearPayload {
  channelId: string;
  /** Temizlenecek alan (isteğe bağlı — belirtilmezse tümü temizlenir) */
  region?: {
    x:      number;
    y:      number;
    width:  number;
    height: number;
  };
}

/** DM okundu bildirimi */
export interface DmReadReceiptPayload {
  dmId:   string;
  readBy: string;   // userId
  /** Okunduğu timestamp (ms epoch) */
  readAt: number;
}

/** Ses aktivitesi payload */
export interface VoiceActivityPayload {
  channelId:  string;
  /** Kullanıcı konuşuyor mu? */
  isSpeaking: boolean;
  /** Geriye dönük uyumluluk — isSpeaking ile aynı anlama gelir */
  speaking:   boolean;
  /** Ses seviyesi 0.0–1.0 (isteğe bağlı, VAD için) */
  level?: number;
}

export interface UserIdentity {
  userId:      string;
  displayName: string;
}

// ─────────────────────────────────────────────────────────────
// Client → Server
// ─────────────────────────────────────────────────────────────

export interface ClientToServerEvents {
  // ── Mesajlaşma ───────────────────────────────────────────
  'message:send': (payload: {
    channelId: string;
    content:   string;
    replyTo?:  string;
    nonce?:    string;
  }) => void;

  'dm:send': (payload: {
    conversationId: string;
    content:        string;
    nonce?:         string;
  }) => void;

  // ── Yazıyor göstergesi ───────────────────────────────────
  'typing:start': (payload: { channelId: string }) => void;
  'typing:stop':  (payload: { channelId: string }) => void;

  // ── Kanal / oda ──────────────────────────────────────────
  'channel:join':  (channelId: string) => void;
  'channel:leave': (channelId: string) => void;

  // ── DM okundu bildirimi ──────────────────────────────────
  /**
   * Kullanıcı bir DM konuşmasını okuduğunda gönderir.
   * read_receipt semantiği — okunduğu an otomatik tetiklenir.
   */
  'dm:read': (payload: DmReadReceiptPayload) => void;

  // ── Canvas ───────────────────────────────────────────────
  /** Kanvasa katıl; sunucu mevcut state'i canvas:state-sync ile gönderir. */
  'canvas:join':  (payload: { channelId: string }) => void;
  'canvas:leave': (payload: { channelId: string }) => void;

  /**
   * Yeni stroke / çizgi ekle.
   * x, y, color, size alanları tip güvenliği için zorunludur.
   */
  'canvas:draw': (payload: {
    channelId: string;
    /** Başlangıç noktası — genellikle points[0] ile aynı */
    x:         number;
    y:         number;
    /** Renk hex kodu — örn. #1a2b3c */
    color:     string;
    /** Kalem boyutu piksel cinsinden (1–40) */
    size:      number;
    stroke: Omit<CanvasStroke, 'userId' | 'displayName' | 'ts'>;
  }) => void;

  /** Stroke geri al (undo). Yalnızca kendi stroke'unu silebilir. */
  'canvas:stroke-delete': (payload: {
    channelId: string;
    strokeId:  string;
  }) => void;

  /**
   * Tüm kanvası temizle.
   * region belirtilirse yalnızca o alan temizlenir.
   */
  'canvas:clear': (payload: CanvasClearPayload) => void;

  /** Geç katılan istemci mevcut durumu ister. */
  'canvas:state-request': (payload: { channelId: string }) => void;

  // ── Çeviri ───────────────────────────────────────────────
  'translate:request': (payload: {
    messageId:  string;
    text:       string;
    targetLang: string;
  }) => void;

  // ── Ses aktivitesi ───────────────────────────────────────
  /**
   * Mikrofon durumu değişti.
   * isSpeaking birincil alan; speaking geriye dönük uyumluluk için korunur.
   */
  'voice:activity': (payload: {
    channelId:  string;
    /** Kullanıcı aktif konuşuyor mu? */
    isSpeaking: boolean;
    /** Geriye dönük uyumluluk */
    speaking:   boolean;
    /** Anlık ses seviyesi 0.0–1.0 */
    level?: number;
  }) => void;
}

// ─────────────────────────────────────────────────────────────
// Server → Client
// ─────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  // ── Mesajlaşma ───────────────────────────────────────────
  'message:new': (payload: {
    _id:         string;
    channelId:   string;
    content:     string;
    userId:      string;
    displayName: string;
    createdAt:   number;
    nonce?:      string;
  }) => void;

  'message:edit': (payload: {
    _id:      string;
    channelId: string;
    content:  string;
    editedAt: number;
  }) => void;

  'message:delete': (payload: {
    _id:       string;
    channelId: string;
  }) => void;

  // ── Kullanıcı durumu ─────────────────────────────────────
  'user:status': (payload: {
    userId: string;
    status: 'online' | 'idle' | 'dnd' | 'offline';
  }) => void;

  // ── Hata / sistem ────────────────────────────────────────
  'error:ratelimit': (payload: {
    event:        string;
    message:      string;
    retryAfter?:  number;
  }) => void;

  'auth:revoked': (payload: {
    reason: 'token_revoked' | 'ban' | 'session_expired' | string;
  }) => void;

  // ── DM okundu bildirimi ──────────────────────────────────
  /**
   * Diğer katılımcı mesajları okuduğunda karşı tarafa gönderilir.
   * WhatsApp/Telegram çift tik eşdeğeri (read_receipt).
   */
  'dm:read-ack': (payload: {
    dmId:   string;
    readBy: string;   // userId
    readAt: number;   // timestamp ms
  }) => void;

  // ── Canvas ───────────────────────────────────────────────
  /**
   * Odadaki diğer kullanıcılara yayılan doğrulanmış stroke.
   * x, y, color, size sunucu tarafından doğrulanmış değerler.
   */
  'canvas:draw': (payload: {
    channelId: string;
    /** Doğrulanmış başlangıç x koordinatı */
    x:         number;
    /** Doğrulanmış başlangıç y koordinatı */
    y:         number;
    /** Doğrulanmış renk */
    color:     string;
    /** Doğrulanmış boyut */
    size:      number;
    stroke:    CanvasStroke;
  }) => void;

  /** Stroke silindi; tüm istemciler kendi çizim listesinden kaldırır. */
  'canvas:stroke-delete': (payload: {
    channelId: string;
    strokeId:  string;
  }) => void;

  /**
   * Kanvas temizlendi.
   * region belirtilmişse yalnızca o alan temizlenmiştir.
   */
  'canvas:clear': (payload: {
    channelId: string;
    clearedBy: UserIdentity;
    clearedAt: number;
    region?:   { x: number; y: number; width: number; height: number };
  }) => void;

  /**
   * Mevcut kanvas durumu (canvas:join veya canvas:state-request sonrası).
   */
  'canvas:state-sync': (payload: {
    channelId: string;
    strokes:   CanvasStroke[];
    clearedAt: number | null;
  }) => void;

  // ── Çeviri sonucu ────────────────────────────────────────
  'translate:result': (payload: {
    messageId:  string;
    translated: string;
    targetLang: string;
    provider:   string;
    cached:     boolean;
  }) => void;

  'translate:error': (payload: {
    messageId: string;
    error:     string;
  }) => void;

  // ── Ses aktivitesi ───────────────────────────────────────
  /**
   * Aynı ses kanalındaki diğer kullanıcılara yayılır.
   * isSpeaking birincil alan; speaking geriye dönük uyumluluk için korunur.
   */
  'voice:activity': (payload: {
    socketId:   string;
    userId:     string;
    /** Kullanıcı aktif konuşuyor mu? */
    isSpeaking: boolean;
    /** Geriye dönük uyumluluk */
    speaking:   boolean;
    /** Anlık ses seviyesi 0.0–1.0 */
    level?: number;
  }) => void;
}

// ─────────────────────────────────────────────────────────────
// Inter-server events
// ─────────────────────────────────────────────────────────────

export interface InterServerEvents {
  ping: () => void;
}

/** socket.data'ya bağlanan kullanıcı bağlamı. */
export interface SocketData {
  userId:       string;
  username:     string;
  displayName:  string;
  tokenVersion: number;
}
