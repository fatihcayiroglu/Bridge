/**
 * bridge-bot-sdk/src/index.ts
 * Bridge Chat — Resmi Bot SDK v2.0.0 (TypeScript)
 *
 * Kullanım:
 *   import { BridgeBot } from 'bridge-bot-sdk';
 *   const bot = new BridgeBot({ token: 'brg_bot_...', serverUrl: 'https://bridge.example.com' });
 *   bot.on('message', msg => { ... });
 *   await bot.connect();
 */

import EventEmitter from 'eventemitter3';
import { io, Socket } from 'socket.io-client';

// ── SDK Sabitleri ──────────────────────────────────────────────
export const SDK_VERSION = '2.0.0';
const DEFAULT_URL        = 'http://localhost:3001';

// ── Temel Tipler ──────────────────────────────────────────────

export interface BotOptions {
  /** Bot token (brg_bot_...) */
  token: string;
  /** Bridge sunucu URL'i (varsayılan: http://localhost:3001) */
  serverUrl?: string;
  /** Detaylı log (varsayılan: false) */
  debug?: boolean;
}

export interface BotInfo {
  _id:         string;
  username:    string;
  displayName?: string;
  avatarUrl?:  string | null;
  description?: string;
}

/** Gelen mesaj nesnesi */
export interface BotMessage {
  _id:       string;
  channelId: string;
  serverId:  string;
  userId:    string;
  content:   string;
  createdAt: number;
  author?:   { _id: string; username: string; displayName?: string };
  /** Eklerin listesi */
  attachments?: Attachment[];
}

export interface Attachment {
  url:       string;
  filename:  string;
  mimeType?: string;
  size?:     number;
}

/** Düzenlenen mesaj verisi */
export interface MessageEditData {
  messageId: string;
  channelId: string;
  content:   string;
  editedAt:  number;
}

/** Silinen mesaj verisi */
export interface MessageDeleteData {
  messageId: string;
  channelId: string;
}

/** Reaksiyon verisi */
export interface ReactionData {
  messageId: string;
  channelId: string;
  userId:    string;
  emoji:     string;
}

/** Üye katılım/ayrılış verisi */
export interface MemberEventData {
  serverId: string;
  userId:   string;
  username?: string;
}

/** Interaction (buton/select/modal/context) verisi */
export interface InteractionData {
  type:      'button' | 'select' | 'modal_submit' | 'user_command' | 'message_command';
  customId:  string;
  userId:    string;
  channelId: string;
  serverId:  string;
  values?:   string[];    // select için
  fields?:   Record<string, string>; // modal için
  targetId?: string;      // context menu hedef ID'si
}

/** Slash komut context nesnesi */
export interface CommandContext {
  message:   BotMessage;
  channelId: string;
  serverId:  string;
  userId:    string;
  args:      string[];
  /** Kanala cevap gönder */
  reply:     (content: string) => Promise<BotMessage | null>;
  /** Mesaja reaksiyon ekle */
  react:     (emoji: string) => Promise<void>;
}

/** Context menu komut context nesnesi */
export interface ContextCommandContext extends InteractionData {
  reply: (content: string) => Promise<BotMessage | null>;
}

/** Modal gönderim context nesnesi */
export interface ModalContext extends InteractionData {
  fields:  Record<string, string>;
  reply:   (content: string) => Promise<BotMessage | null>;
}

/** Rate limit event verisi */
export interface RateLimitData {
  path:        string;
  method:      string;
  retryAfter:  number;
  retryCount:  number;
}

/** Slash komut tanımı */
export interface CommandDefinition {
  name:        string;
  description: string;
  usage:       string;
  handler:     (ctx: CommandContext) => Promise<void>;
}

/** Context menu komut tanımı */
export interface ContextCommandDefinition {
  name:    string;
  type:    'USER_COMMAND' | 'MESSAGE_COMMAND';
  handler: (ctx: ContextCommandContext) => Promise<void>;
}

/** Modal tanımı */
export interface ModalField {
  id:          string;
  label:       string;
  placeholder?: string;
  required?:   boolean;
  type?:       'text' | 'textarea';
}

export interface ModalDefinition {
  customId:  string;
  title:     string;
  fields:    ModalField[];
}

/** EventEmitter olay haritası */
export interface BotEvents {
  ready:        [info: BotInfo];
  disconnect:   [reason: string];
  reconnect:    [];
  message:      [msg: BotMessage];
  messageEdit:  [data: MessageEditData];
  messageDelete:[data: MessageDeleteData];
  reaction:     [data: ReactionData];
  memberJoin:   [data: MemberEventData];
  memberLeave:  [data: MemberEventData];
  interaction:  [data: InteractionData];
  contextCommand:[data: InteractionData];
  commandError: [data: { command: string; error: Error; ctx: CommandContext }];
  rateLimit:    [data: RateLimitData];
  error:        [err: unknown];
}

// ── Ana Sınıf ─────────────────────────────────────────────────

export class BridgeBot extends EventEmitter<BotEvents> {
  private readonly token:     string;
  private readonly serverUrl: string;
  private readonly debug:     boolean;

  private socket:           Socket | null     = null;
  public  info:             BotInfo | null    = null;
  private _connected:       boolean           = false;
  private _commands        = new Map<string, CommandDefinition>();
  private _contextCommands = new Map<string, ContextCommandDefinition>();
  private _modalHandlers   = new Map<string, (ctx: ModalContext) => Promise<void>>();

  constructor({ token, serverUrl = DEFAULT_URL, debug = false }: BotOptions) {
    super();
    if (!token) throw new Error('[BridgeBot] token gerekli');
    this.token     = token;
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.debug     = debug;
  }

  // ── Bağlantı ────────────────────────────────────────────────

  /** Bridge sunucusuna bağlan. */
  async connect(): Promise<BridgeBot> {
    this.info = await this._fetchBotInfo();
    this._log(`Bot bağlanıyor: ${this.info?.username ?? 'bilinmiyor'} (SDK ${SDK_VERSION})`);

    this.socket = io(this.serverUrl, {
      auth:                { token: this.token, isBot: true },
      transports:          ['websocket'],
      reconnection:        true,
      reconnectionDelay:   2000,
      reconnectionDelayMax: 30000,
    });

    this._bindSocketEvents();

    return new Promise<BridgeBot>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[BridgeBot] Bağlantı zaman aşımı')),
        15_000,
      );

      this.socket!.once('connect', () => {
        clearTimeout(timeout);
        this._connected = true;
        this._log('Bağlantı kuruldu');
        this.emit('ready', this.info!);
        resolve(this);
      });

      this.socket!.once('connect_error', (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`[BridgeBot] Bağlantı hatası: ${err.message}`));
      });
    });
  }

  /** Bağlantıyı kapat. */
  disconnect(): void {
    this.socket?.disconnect();
    this._connected = false;
    this._log('Bağlantı kapatıldı');
  }

  /** Bağlantı durumu */
  get isConnected(): boolean {
    return this._connected;
  }

  // ── Slash Komutlar ──────────────────────────────────────────

  /**
   * Slash komut tanımla.
   * @param name    Komut adı (ör. "ping")
   * @param options description, usage, handler
   */
  command(
    name: string,
    options: { description?: string; usage?: string; handler: CommandDefinition['handler'] },
  ): this {
    const { description = '', usage = '', handler } = options;
    if (typeof handler !== 'function')
      throw new Error(`[BridgeBot] command handler fonksiyon olmalı: /${name}`);
    this._commands.set(name.toLowerCase(), { name, description, usage, handler });
    this._log(`Komut kaydedildi: /${name}`);
    return this;
  }

  // ── Context Menu Komutları ───────────────────────────────────

  /**
   * Context menu komutu tanımla (sağ-tık menüsü).
   * @param name    Komut adı
   * @param type    USER_COMMAND | MESSAGE_COMMAND
   * @param handler (ctx) => Promise<void>
   */
  contextCommand(
    name: string,
    type: ContextCommandDefinition['type'],
    handler: ContextCommandDefinition['handler'],
  ): this {
    if (!['USER_COMMAND', 'MESSAGE_COMMAND'].includes(type))
      throw new Error(`[BridgeBot] Geçersiz context command tipi: ${type}`);
    if (typeof handler !== 'function')
      throw new Error(`[BridgeBot] context command handler fonksiyon olmalı: ${name}`);
    this._contextCommands.set(name, { name, type, handler });
    this._log(`Context command kaydedildi: ${name} (${type})`);
    return this;
  }

  /** Context menu komutlarını sunucuya kaydet. */
  async registerContextCommands(): Promise<void> {
    if (!this._contextCommands.size) return;
    const commands = [...this._contextCommands.values()].map(c => ({
      name: c.name,
      type: c.type,
      description: '',
    }));
    await this._api('PATCH', '/api/bots/me/context-commands', { commands });
    this._log(`${commands.length} context command sunucuya kaydedildi`);
  }

  // ── Modal ────────────────────────────────────────────────────

  /**
   * Kullanıcıya modal (form) göster.
   * @param userId Hedef kullanıcı ID'si
   * @param modal  Modal tanımı
   */
  showModal(userId: string, modal: ModalDefinition): void {
    if (!this.socket) throw new Error('[BridgeBot] Bağlı değil');
    if (!modal?.customId || !modal?.title)
      throw new Error('[BridgeBot] Modal customId ve title gerekli');
    this.socket.emit('bot:showModal', { userId, modal });
    this._log(`Modal gönderildi: ${modal.title} → ${userId}`);
  }

  /**
   * Modal gönderim eventini dinle.
   * @param customId  Modal ID
   * @param handler   (ctx: ModalContext) => Promise<void>
   */
  onModalSubmit(customId: string, handler: (ctx: ModalContext) => Promise<void>): this {
    this._modalHandlers.set(customId, handler);
    return this;
  }

  // ── Mesajlaşma ───────────────────────────────────────────────

  /** Kanala mesaj gönder. */
  async sendMessage(channelId: string, content: string): Promise<BotMessage | null> {
    return this._api('POST', `/api/messages/${channelId}`, { content });
  }

  /** Mesajı düzenle. */
  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<BotMessage | null> {
    return this._api('PATCH', `/api/messages/${channelId}/${messageId}`, { content });
  }

  /** Mesajı sil. */
  async deleteMessage(channelId: string, messageId: string): Promise<null> {
    return this._api('DELETE', `/api/messages/${channelId}/${messageId}`);
  }

  /** Mesaja reaksiyon ekle. */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<null> {
    return this._api('POST', `/api/messages/${channelId}/${messageId}/react`, { emoji });
  }

  /** Kanalın son mesajlarını getir. */
  async getMessages(channelId: string, limit = 50): Promise<BotMessage[]> {
    return this._api('GET', `/api/messages/${channelId}?limit=${limit}`);
  }

  /** Interactive (butonlu) mesaj gönder. */
  async sendInteractiveMessage(
    channelId: string,
    content: string,
    components: ActionRow[],
  ): Promise<BotMessage | null> {
    return this._api('POST', `/api/messages/${channelId}`, { content, components });
  }

  // ── Sunucu ──────────────────────────────────────────────────

  /** Sunucu üyelerini getir. */
  async getMembers(serverId: string): Promise<ServerMember[]> {
    return this._api('GET', `/api/servers/${serverId}/members`);
  }

  /** Üyeye rol ata. */
  async addRole(serverId: string, userId: string, roleId: string): Promise<null> {
    return this._api('POST', `/api/servers/${serverId}/members/${userId}/roles`, { roleId });
  }

  /** Üyeden rol kaldır. */
  async removeRole(serverId: string, userId: string, roleId: string): Promise<null> {
    return this._api('DELETE', `/api/servers/${serverId}/members/${userId}/roles/${roleId}`);
  }

  // ── Moderasyon ───────────────────────────────────────────────

  /** Kullanıcıyı at (kick). */
  async kick(serverId: string, userId: string, reason = ''): Promise<null> {
    return this._api('POST', `/api/servers/${serverId}/kick`, { userId, reason });
  }

  /** Kullanıcıyı yasakla (ban). */
  async ban(serverId: string, userId: string, reason = ''): Promise<null> {
    return this._api('POST', `/api/servers/${serverId}/ban`, { userId, reason });
  }

  /** Kullanıcıyı sustur (timeout). */
  async timeout(
    serverId: string,
    userId: string,
    minutes = 10,
    reason = '',
  ): Promise<null> {
    return this._api('POST', `/api/servers/${serverId}/timeout`, { userId, minutes, reason });
  }

  // ── Socket Olayları (İç) ─────────────────────────────────────

  private _bindSocketEvents(): void {
    const s = this.socket!;

    s.on('disconnect', (reason: string) => {
      this._connected = false;
      this._log(`Bağlantı koptu: ${reason}`);
      this.emit('disconnect', reason);
    });

    s.on('reconnect', () => {
      this._connected = true;
      this._log('Yeniden bağlandı');
      this.emit('reconnect');
    });

    // Yeni mesaj
    const onMessage = (msg: BotMessage) => {
      this.emit('message', msg);
      void this._handleSlashCommand(msg);
    };
    s.on('message', onMessage);
    s.on('channel:message', onMessage);

    s.on('message:edit',   (data: MessageEditData)   => this.emit('messageEdit',   data));
    s.on('message:delete', (data: MessageDeleteData) => this.emit('messageDelete', data));
    s.on('message:react',  (data: ReactionData)      => this.emit('reaction',      data));
    s.on('member:join',    (data: MemberEventData)   => this.emit('memberJoin',    data));
    s.on('member:leave',   (data: MemberEventData)   => this.emit('memberLeave',   data));

    s.on('interaction', (data: InteractionData) => {
      this.emit('interaction', data);

      // Modal submit
      if (data.type === 'modal_submit' && data.customId) {
        const handler = this._modalHandlers.get(data.customId);
        if (handler) {
          const ctx: ModalContext = {
            ...data,
            fields: data.fields ?? {},
            reply:  (content) => this.sendMessage(data.channelId, content),
          };
          handler(ctx).catch((err: Error) =>
            this._log(`Modal handler hatası: ${err.message}`),
          );
        }
      }

      // Context menu komutları
      if (
        (data.type === 'user_command' || data.type === 'message_command') &&
        data.customId
      ) {
        const cmd = this._contextCommands.get(data.customId);
        if (cmd) {
          const ctx: ContextCommandContext = {
            ...data,
            reply: (content) => this.sendMessage(data.channelId, content),
          };
          cmd.handler(ctx).catch((err: Error) =>
            this._log(`Context command hatası (${data.customId}): ${err.message}`),
          );
        }
        this.emit('contextCommand', data);
      }
    });

    s.on('error', (err: unknown) => {
      this._log(`Socket hatası: ${err}`);
      this.emit('error', err);
    });
  }

  private async _handleSlashCommand(msg: BotMessage): Promise<void> {
    if (!msg?.content?.startsWith('/')) return;
    const [rawName = '', ...args] = msg.content.trim().slice(1).split(/\s+/);
    const name = rawName.toLowerCase();
    if (!name) return;

    const cmd = this._commands.get(name);
    if (!cmd) return;

    const ctx: CommandContext = {
      message:   msg,
      channelId: msg.channelId,
      serverId:  msg.serverId,
      userId:    msg.userId,
      args,
      reply: (content) => this.sendMessage(ctx.channelId, content),
      react: (emoji)   => this.addReaction(ctx.channelId, msg._id, emoji).then(() => {}),
    };

    try {
      await cmd.handler(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this._log(`Komut hatası (/${name}): ${e.message}`);
      this.emit('commandError', { command: name, error: e, ctx });
    }
  }

  private async _fetchBotInfo(): Promise<BotInfo> {
    try {
      return await this._api<BotInfo>('GET', '/api/bots/me');
    } catch {
      return { _id: '', username: 'Bot' };
    }
  }

  private async _api<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    _retryCount = 0,
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    this._log(`${method} ${path}`);

    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type':  'application/json',
        'X-Bridge-SDK':  SDK_VERSION,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    // Rate limit — Retry-After başlığını oku ve bekle
    if (res.status === 429 && _retryCount < 3) {
      const retryAfterSec = parseFloat(res.headers.get('retry-after') ?? '1');
      const retryAfterMs  = Math.ceil(retryAfterSec * 1000);
      this._log(`Rate limit hit. Retry-After: ${retryAfterSec}s`);
      this.emit('rateLimit', { path, method, retryAfter: retryAfterSec, retryCount: _retryCount });
      await new Promise<void>(r => setTimeout(r, retryAfterMs));
      return this._api(method, path, body, _retryCount + 1);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`API hatası ${res.status}: ${err.error ?? res.statusText}`);
    }

    return res.status === 204 ? null as unknown as T : (res.json() as Promise<T>);
  }

  private _log(...args: unknown[]): void {
    if (this.debug) console.log('[BridgeBot]', ...args);
  }
}

// ── Yardımcı Türler (Component) ──────────────────────────────

export interface Button {
  customId:  string;
  label:     string;
  style?:    'primary' | 'secondary' | 'success' | 'danger' | 'link';
  disabled?: boolean;
  url?:      string | null;
}

export interface ActionRow {
  type:    'action_row';
  buttons: Button[];
}

export interface ServerMember {
  _id:          string;
  userId:       string;
  serverId:     string;
  nickname?:    string | null;
  joinedAt:     number;
}

// ── MessageBuilder ───────────────────────────────────────────

/**
 * Basit markdown mesaj oluşturucu.
 *
 * @example
 * const msg = new MessageBuilder()
 *   .title('Merhaba!')
 *   .text('Bridge\'e hoşgeldiniz.')
 *   .field('Versiyon', SDK_VERSION)
 *   .build();
 */
export class MessageBuilder {
  private readonly _lines: string[] = [];

  title(text: string): this                     { this._lines.push(`**${text}**`);                              return this; }
  text(text: string): this                      { this._lines.push(text);                                        return this; }
  field(name: string, val: string): this        { this._lines.push(`**${name}:** ${val}`);                       return this; }
  divider(): this                               { this._lines.push('─────────────────────');                     return this; }
  code(text: string, lang = ''): this           { this._lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);           return this; }

  build(): string { return this._lines.join('\n'); }
}

// ── BotStore ─────────────────────────────────────────────────

/**
 * Basit anahtar-değer hafıza deposu (bot state için).
 *
 * @example
 * const store = new BotStore<number>();
 * store.set('counter', 0);
 * store.set('counter', (store.get('counter') ?? 0) + 1);
 */
export class BotStore<V = unknown> {
  private readonly _data = new Map<string, V>();

  get(key: string): V | undefined        { return this._data.get(key); }
  set(key: string, val: V): this         { this._data.set(key, val); return this; }
  delete(key: string): boolean           { return this._data.delete(key); }
  has(key: string): boolean              { return this._data.has(key); }
  clear(): void                          { this._data.clear(); }
}

// ── EmbedBuilder ─────────────────────────────────────────────

export interface EmbedFieldOptions {
  /** Inline alanlar yan yana gösterilir */
  inline?: boolean;
}

/**
 * Discord embed benzeri zengin kart oluşturucu.
 *
 * @example
 * const embed = new EmbedBuilder()
 *   .setTitle('🎉 Duyuru')
 *   .setDescription('Açıklama')
 *   .addField('Alan 1', 'Değer 1')
 *   .addField('Alan 2', 'Değer 2', { inline: true })
 *   .setFooter('Bot adı • az önce')
 *   .build();
 */
export class EmbedBuilder {
  private _title?:       string;
  private _description?: string;
  private _footer?:      string;
  private _color?:       string;
  private readonly _fields: Array<{ name: string; value: string; inline: boolean }> = [];

  setTitle(text: string): this       { this._title = text;       return this; }
  setDescription(text: string): this { this._description = text; return this; }
  setFooter(text: string): this      { this._footer = text;      return this; }
  /** Gelecekte renk desteği için (şu an yok sayılır) */
  setColor(hex: string): this        { this._color = hex;        return this; }

  addField(name: string, value: string, opts: EmbedFieldOptions = {}): this {
    this._fields.push({ name, value, inline: opts.inline ?? false });
    return this;
  }

  build(): string {
    const lines: string[] = [];
    if (this._title) lines.push(`**${this._title}**`);
    lines.push('─────────────────────');
    if (this._description) lines.push(this._description);
    if (this._description && this._fields.length) lines.push('');

    const inlines = this._fields.filter(f => f.inline);
    const blocks  = this._fields.filter(f => !f.inline);

    if (inlines.length) {
      lines.push(inlines.map(f => `**${f.name}:** ${f.value}`).join('  ·  '));
    }
    for (const field of blocks) {
      lines.push(`**${field.name}**\n${field.value}`);
    }

    if (this._footer) {
      lines.push('─────────────────────');
      lines.push(`*${this._footer}*`);
    }
    return lines.join('\n');
  }
}

// ── ButtonBuilder ────────────────────────────────────────────

/**
 * Bridge interaction sistemi için buton listesi oluşturucu.
 *
 * @example
 * const buttons = new ButtonBuilder()
 *   .addButton({ customId: 'onayla', label: '✅ Onayla', style: 'success' })
 *   .addButton({ customId: 'reddet', label: '❌ Reddet', style: 'danger'  })
 *   .build();
 *
 * await bot.sendInteractiveMessage(channelId, 'Onaylıyor musunuz?', [buttons.build()]);
 */
export class ButtonBuilder {
  private readonly _buttons: Button[] = [];

  /**
   * Buton ekle.
   * @param btn.customId Tıklama eventi için ID
   * @param btn.label    Buton metni
   * @param btn.style    primary | secondary | success | danger | link
   * @param btn.disabled Devre dışı mı?
   * @param btn.url      style='link' için URL
   */
  addButton({
    customId,
    label,
    style    = 'primary',
    disabled = false,
    url      = null,
  }: {
    customId:  string;
    label:     string;
    style?:    Button['style'];
    disabled?: boolean;
    url?:      string | null;
  }): this {
    if (!customId || !label)
      throw new Error('[ButtonBuilder] customId ve label zorunlu');
    this._buttons.push({ customId, label, style, disabled, url });
    return this;
  }

  /** ActionRow olarak döndürür — sendInteractiveMessage'a ver */
  build(): ActionRow {
    return { type: 'action_row', buttons: this._buttons };
  }

  /** Terminal debug için metin gösterimi */
  toString(): string {
    return this._buttons.map(b => `[${b.label}]`).join(' ');
  }
}

// ── PaginationHelper ─────────────────────────────────────────

export interface PaginationPage {
  content:  string;
  current:  number;
  total:    number;
  hasNext:  boolean;
  hasPrev:  boolean;
}

export interface PaginationOptions<T> {
  pageSize?:  number;
  title?:     string;
  formatter?: (item: T, index: number) => string;
}

/**
 * Uzun listeleri sayfalara böler.
 *
 * @example
 * const pager = new PaginationHelper(items, { pageSize: 10, title: '📋 Liste' });
 * const page  = pager.getPage(0);
 * await bot.sendMessage(channelId, page.content);
 * // page.hasNext, page.hasPrev, page.current, page.total
 */
export class PaginationHelper<T> {
  private readonly _items:     T[];
  private readonly _pageSize:  number;
  private readonly _title:     string;
  private readonly _formatter: (item: T, index: number) => string;
  readonly total: number;

  constructor(items: T[], opts: PaginationOptions<T> = {}) {
    if (!Array.isArray(items))
      throw new Error('[PaginationHelper] items bir dizi olmalı');
    this._items     = items;
    this._pageSize  = Math.max(1, opts.pageSize ?? 10);
    this._title     = opts.title ?? '';
    this._formatter = opts.formatter ?? ((item) => String(item));
    this.total      = Math.ceil(items.length / this._pageSize) || 1;
  }

  /**
   * Belirtilen sayfayı döndürür.
   * @param page 0-indexed sayfa numarası
   */
  getPage(page = 0): PaginationPage {
    const p     = Math.max(0, Math.min(page, this.total - 1));
    const start = p * this._pageSize;
    const slice = this._items.slice(start, start + this._pageSize);

    const lines: string[] = [];
    if (this._title) lines.push(`**${this._title}** (${p + 1}/${this.total})`);
    lines.push('─────────────────────');
    slice.forEach((item, i) => lines.push(this._formatter(item, start + i)));

    if (this.total > 1) {
      lines.push('─────────────────────');
      const nav: string[] = [];
      if (p > 0)              nav.push(`◀ Önceki: sayfa ${p}`);
      if (p < this.total - 1) nav.push(`Sonraki: sayfa ${p + 2} ▶`);
      lines.push(nav.join('  ·  '));
    }

    return {
      content: lines.join('\n'),
      current: p,
      total:   this.total,
      hasNext: p < this.total - 1,
      hasPrev: p > 0,
    };
  }
}
