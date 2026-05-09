// bot-sdk/src/index.js — Bridge Bot SDK v2.0.0
// Bridge Chat sunucusu için resmi bot geliştirme kütüphanesi.
//
// Kullanım:
//   const { BridgeBot } = require('bridge-bot-sdk');
//   const bot = new BridgeBot({ token: 'brg_bot_...', serverUrl: 'https://bridge.example.com' });
//   bot.on('message', msg => { ... });
//   bot.connect();

'use strict';

const EventEmitter = require('eventemitter3');
const { io }       = require('socket.io-client');

// ── SABITLER ──────────────────────────────────────────────────
const SDK_VERSION  = '1.2.0';
const DEFAULT_URL  = 'http://localhost:3001';

// ── ANA SINIF ─────────────────────────────────────────────────
class BridgeBot extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.token       - Bot token (brg_bot_...)
   * @param {string} [options.serverUrl] - Bridge sunucu URL'i
   * @param {boolean} [options.debug]    - Detaylı log
   */
  constructor({ token, serverUrl = DEFAULT_URL, debug = false } = {}) {
    super();

    if (!token) throw new Error('[BridgeBot] token gerekli');

    this.token            = token;
    this.serverUrl        = serverUrl.replace(/\/$/, '');
    this.debug            = debug;
    this.socket           = null;
    this.info             = null;   // Bot metadata (sunucudan alınır)
    this._commands        = new Map();
    this._contextCommands = new Map();
    this._modalHandlers   = new Map();
    this._connected       = false;
  }

  // ── BAĞLANTI ────────────────────────────────────────────────
  /**
   * Bridge sunucusuna bağlan.
   * @returns {Promise<BridgeBot>}
   */
  async connect() {
    // Bot bilgilerini al
    this.info = await this._fetchBotInfo();
    this._log(`Bot bağlanıyor: ${this.info?.username || 'bilinmiyor'} (SDK ${SDK_VERSION})`);

    // Socket.IO bağlantısı kur
    this.socket = io(this.serverUrl, {
      auth: { token: this.token, isBot: true },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    });

    this._bindSocketEvents();

    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => {
        this._connected = true;
        this._log('Bağlantı kuruldu');
        this.emit('ready', this.info);
        resolve(this);
      });
      this.socket.once('connect_error', err => {
        reject(new Error(`[BridgeBot] Bağlantı hatası: ${err.message}`));
      });
      setTimeout(() => reject(new Error('[BridgeBot] Bağlantı zaman aşımı')), 15000);
    });
  }

  /**
   * Bağlantıyı kapat.
   */
  disconnect() {
    this.socket?.disconnect();
    this._connected = false;
    this._log('Bağlantı kapatıldı');
  }

  // ── SLASH KOMUTLAR ──────────────────────────────────────────
  /**
   * Slash komut tanımla.
   * @param {string}   name    - Komut adı (ör. "ping")
   * @param {object}   options - { description, usage, handler }
   */
  command(name, { description = '', usage = '', handler } = {}) {
    if (typeof handler !== 'function') throw new Error(`[BridgeBot] command handler fonksiyon olmalı: /${name}`);
    this._commands.set(name.toLowerCase(), { name, description, usage, handler });
    this._log(`Komut kaydedildi: /${name}`);
    return this;
  }

  // ── CONTEXT MENU KOMUTLARI ───────────────────────────────────
  /**
   * Context menu komutu tanımla (sağ-tık menüsü).
   * @param {string} name - Komut adı
   * @param {'USER_COMMAND'|'MESSAGE_COMMAND'} type - Komut tipi
   * @param {Function} handler - (ctx) => Promise<void>
   */
  contextCommand(name, type, handler) {
    if (!['USER_COMMAND', 'MESSAGE_COMMAND'].includes(type))
      throw new Error(`[BridgeBot] Geçersiz context command tipi: ${type}`);
    if (typeof handler !== 'function')
      throw new Error(`[BridgeBot] context command handler fonksiyon olmalı: ${name}`);
    this._contextCommands.set(name, { name, type, handler });
    this._log(`Context command kaydedildi: ${name} (${type})`);
    return this;
  }

  /**
   * Context menu komutlarını sunucuya kaydet.
   */
  async registerContextCommands() {
    if (!this._contextCommands.size) return;
    const commands = [...this._contextCommands.values()].map(c => ({
      name: c.name, type: c.type, description: '',
    }));
    await this._api('PATCH', '/api/bots/me/context-commands', { commands });
    this._log(`${commands.length} context command sunucuya kaydedildi`);
  }

  // ── MODAL ────────────────────────────────────────────────────
  /**
   * Kullanıcıya modal (form) göster.
   * @param {string} userId   - Modal gösterilecek kullanıcı ID'si
   * @param {object} modal    - { customId, title, fields: [{id, label, placeholder, required, type}] }
   */
  showModal(userId, modal) {
    if (!this.socket) throw new Error('[BridgeBot] Bağlı değil');
    if (!modal?.customId || !modal?.title) throw new Error('[BridgeBot] Modal customId ve title gerekli');
    this.socket.emit('bot:showModal', { userId, modal });
    this._log(`Modal gönderildi: ${modal.title} → ${userId}`);
  }

  /**
   * Modal gönderim event'ini dinle.
   * @param {string} customId - Modal ID
   * @param {Function} handler - (ctx) => Promise<void>
   */
  onModalSubmit(customId, handler) {
    this._modalHandlers.set(customId, handler);
    return this;
  }

  // ── MESAJLAŞMA ───────────────────────────────────────────────
  /**
   * Kanala mesaj gönder.
   */
  async sendMessage(channelId, content) {
    return this._api('POST', `/api/messages/${channelId}`, { content });
  }

  /**
   * Mesajı düzenle.
   */
  async editMessage(channelId, messageId, content) {
    return this._api('PATCH', `/api/messages/${channelId}/${messageId}`, { content });
  }

  /**
   * Mesajı sil.
   */
  async deleteMessage(channelId, messageId) {
    return this._api('DELETE', `/api/messages/${channelId}/${messageId}`);
  }

  /**
   * Mesaja reaksiyon ekle.
   */
  async addReaction(channelId, messageId, emoji) {
    return this._api('POST', `/api/messages/${channelId}/${messageId}/react`, { emoji });
  }

  // ── SUNUCU ──────────────────────────────────────────────────
  /**
   * Sunucu üyelerini getir.
   */
  async getMembers(serverId) {
    return this._api('GET', `/api/servers/${serverId}/members`);
  }

  /**
   * Üyeye rol ata.
   */
  async addRole(serverId, userId, roleId) {
    return this._api('POST', `/api/servers/${serverId}/members/${userId}/roles`, { roleId });
  }

  /**
   * Üyeden rol kaldır.
   */
  async removeRole(serverId, userId, roleId) {
    return this._api('DELETE', `/api/servers/${serverId}/members/${userId}/roles/${roleId}`);
  }

  // ── MODERASYON ───────────────────────────────────────────────
  /**
   * Kullanıcıyı at (kick).
   */
  async kick(serverId, userId, reason = '') {
    return this._api('POST', `/api/servers/${serverId}/kick`, { userId, reason });
  }

  /**
   * Kullanıcıyı yasakla (ban).
   */
  async ban(serverId, userId, reason = '') {
    return this._api('POST', `/api/servers/${serverId}/ban`, { userId, reason });
  }

  /**
   * Kullanıcıyı sustur (timeout).
   */
  async timeout(serverId, userId, minutes = 10, reason = '') {
    return this._api('POST', `/api/servers/${serverId}/timeout`, { userId, minutes, reason });
  }

  // ── KANAL ────────────────────────────────────────────────────
  /**
   * Kanalın son mesajlarını getir.
   */
  async getMessages(channelId, limit = 50) {
    return this._api('GET', `/api/messages/${channelId}?limit=${limit}`);
  }

  // ── YARDIMCI ─────────────────────────────────────────────────
  get isConnected() { return this._connected; }

  // ── SOCKET OLAYLARI (İÇ) ────────────────────────────────────
  _bindSocketEvents() {
    const s = this.socket;

    s.on('disconnect', reason => {
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
    s.on('message', msg => {
      this.emit('message', msg);
      this._handleSlashCommand(msg);
    });

    // Kanal mesajları
    s.on('channel:message', msg => {
      this.emit('message', msg);
      this._handleSlashCommand(msg);
    });

    // Düzenlenen mesaj
    s.on('message:edit', data => this.emit('messageEdit', data));

    // Silinen mesaj
    s.on('message:delete', data => this.emit('messageDelete', data));

    // Reaksiyon
    s.on('message:react', data => this.emit('reaction', data));

    // Üye katıldı
    s.on('member:join', data => this.emit('memberJoin', data));

    // Üye ayrıldı
    s.on('member:leave', data => this.emit('memberLeave', data));

    // Buton/select interaction
    s.on('interaction', data => {
      this.emit('interaction', data);
      // Modal submit
      if (data.type === 'modal_submit' && data.customId) {
        const handler = this._modalHandlers.get(data.customId);
        if (handler) {
          const ctx = { ...data, reply: (content) => this.sendMessage(data.channelId, content) };
          handler(ctx).catch(err => this._log(`Modal handler hatası: ${err.message}`));
        }
      }
      // Context menu komutları
      if (['user_command', 'message_command'].includes(data.type) && data.customId) {
        const cmdKey = data.customId;
        const cmd = this._contextCommands.get(cmdKey);
        if (cmd) {
          const ctx = {
            ...data,
            reply: (content) => this.sendMessage(data.channelId, content),
          };
          cmd.handler(ctx).catch(err => this._log(`Context command hatası (${cmdKey}): ${err.message}`));
        }
        this.emit('contextCommand', data);
      }
    });

    // Hata
    s.on('error', err => {
      this._log(`Socket hatası: ${err}`);
      this.emit('error', err);
    });
  }

  async _handleSlashCommand(msg) {
    if (!msg?.content?.startsWith('/')) return;
    const [rawName, ...args] = msg.content.trim().slice(1).split(/\s+/);
    const name = rawName?.toLowerCase();
    if (!name) return;

    const cmd = this._commands.get(name);
    if (!cmd) return;

    // Bağlam nesnesi
    const ctx = {
      message:   msg,
      channelId: msg.channelId || msg.channel,
      serverId:  msg.serverId,
      userId:    msg.userId || msg.author?._id,
      args,
      // Kolaylık metodları
      reply: (content) => this.sendMessage(ctx.channelId, content),
      react: (emoji)   => this.addReaction(ctx.channelId, msg._id, emoji),
    };

    try {
      await cmd.handler(ctx);
    } catch (err) {
      this._log(`Komut hatası (/${name}): ${err.message}`);
      this.emit('commandError', { command: name, error: err, ctx });
    }
  }

  async _fetchBotInfo() {
    try {
      const res = await this._api('GET', '/api/bots/me');
      return res;
    } catch {
      return { username: 'Bot' };
    }
  }

  async _api(method, path, body, _retryCount = 0) {
    const fetch = globalThis.fetch;
    const url = `${this.serverUrl}${path}`;
    this._log(`${method} ${path}`);

    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        'X-Bridge-SDK': SDK_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Rate limit — Retry-After başlığını oku ve bekle
    if (res.status === 429 && _retryCount < 3) {
      const retryAfterSec = parseFloat(res.headers.get('retry-after') || '1');
      const retryAfterMs  = Math.ceil(retryAfterSec * 1000);
      this._log(`Rate limit hit. Retry-After: ${retryAfterSec}s`);
      this.emit('rateLimit', { path, method, retryAfter: retryAfterSec, retryCount: _retryCount });
      await new Promise(r => setTimeout(r, retryAfterMs));
      return this._api(method, path, body, _retryCount + 1);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`API hatası ${res.status}: ${err.error || res.statusText}`);
    }

    return res.status === 204 ? null : res.json();
  }

  _log(...args) {
    if (this.debug) console.log('[BridgeBot]', ...args);
  }
}

// ── YARDIMCI SINIFLAR ─────────────────────────────────────────

/**
 * Embed benzeri zengin mesaj oluşturucu.
 * Bridge sunduğu markdown'ı kullanır.
 */
class MessageBuilder {
  constructor() {
    this._lines = [];
  }

  title(text)       { this._lines.push(`**${text}**`);             return this; }
  text(text)        { this._lines.push(text);                       return this; }
  field(name, val)  { this._lines.push(`**${name}:** ${val}`);      return this; }
  divider()         { this._lines.push('─────────────────────');    return this; }
  code(text, lang = '') { this._lines.push(`\`\`\`${lang}\n${text}\n\`\`\``); return this; }

  build() { return this._lines.join('\n'); }
}

/**
 * Basit anahtar-değer hafıza deposu (bot state için).
 */
class BotStore {
  constructor() { this._data = new Map(); }
  get(key)         { return this._data.get(key); }
  set(key, val)    { this._data.set(key, val); return this; }
  delete(key)      { return this._data.delete(key); }
  has(key)         { return this._data.has(key); }
  clear()          { this._data.clear(); }
}

// ── v68: EmbedBuilder — Discord embed benzeri zengin kart ─────
/**
 * Bridge markdown formatını kullanarak embed-benzeri zengin mesajlar üretir.
 *
 * @example
 * const embed = new EmbedBuilder()
 *   .setTitle('🎉 Duyuru')
 *   .setDescription('Açıklama metni')
 *   .addField('Alan 1', 'Değer 1')
 *   .addField('Alan 2', 'Değer 2', true) // inline
 *   .setFooter('Bot adı • az önce')
 *   .build();
 */
class EmbedBuilder {
  constructor() {
    this._title       = null;
    this._description = null;
    this._fields      = [];
    this._footer      = null;
    this._color       = null;
  }

  setTitle(text)       { this._title = text;       return this; }
  setDescription(text) { this._description = text; return this; }
  setFooter(text)      { this._footer = text;       return this; }
  setColor(hex)        { this._color = hex;         return this; } // gelecekte renk desteği

  addField(name, value, inline = false) {
    this._fields.push({ name, value, inline });
    return this;
  }

  build() {
    const lines = [];
    if (this._title)       lines.push(`**${this._title}**`);
    lines.push('─────────────────────');
    if (this._description) lines.push(this._description);
    if (this._description && this._fields.length) lines.push('');

    // Inline alanlar: yan yana göster
    const inlines = this._fields.filter(f => f.inline);
    const blocks  = this._fields.filter(f => !f.inline);

    if (inlines.length) {
      const row = inlines.map(f => `**${f.name}:** ${f.value}`).join('  ·  ');
      lines.push(row);
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

// ── v68: ButtonBuilder — buton bileşeni oluşturucu ─────────────
/**
 * Bridge interaction sistemi için buton listesi oluşturur.
 * Sonuç nesnesi bot.sendMessage'a value olarak verilemez —
 * bunun yerine buton objesini socket üzerinden iletmek için
 * bot.sendInteractiveMessage() kullanılmalıdır.
 *
 * @example
 * const buttons = new ButtonBuilder()
 *   .addButton({ customId: 'onayla', label: '✅ Onayla', style: 'success' })
 *   .addButton({ customId: 'reddet', label: '❌ Reddet', style: 'danger'  })
 *   .build();
 */
class ButtonBuilder {
  constructor() {
    this._buttons = [];
  }

  /**
   * Buton ekle.
   * @param {object} btn
   * @param {string} btn.customId - Tıklama eventi için ID
   * @param {string} btn.label    - Buton metni
   * @param {'primary'|'secondary'|'success'|'danger'|'link'} [btn.style='primary']
   * @param {boolean} [btn.disabled=false]
   * @param {string}  [btn.url]   - style='link' için URL
   */
  addButton({ customId, label, style = 'primary', disabled = false, url = null } = {}) {
    if (!customId || !label) throw new Error('[ButtonBuilder] customId ve label zorunlu');
    this._buttons.push({ customId, label, style, disabled, url });
    return this;
  }

  /** Buton dizisini döndürür — socket payload'ına ekle */
  build() {
    return {
      type:    'action_row',
      buttons: this._buttons,
    };
  }

  /** Metin formatında butonları göster (terminal debug için) */
  toString() {
    return this._buttons.map(b => `[${b.label}]`).join(' ');
  }
}

// ── v68: PaginationHelper — uzun listeleri sayfalara böl ────────
/**
 * @example
 * const pager = new PaginationHelper(items, { pageSize: 10, title: '📋 Liste' });
 * const page  = pager.getPage(0);
 * await bot.sendMessage(channelId, page.content);
 * // page.hasNext, page.hasPrev, page.current, page.total
 */
class PaginationHelper {
  /**
   * @param {Array}    items             - Sayfalanacak eleman dizisi
   * @param {object}   opts
   * @param {number}   [opts.pageSize=10]
   * @param {string}   [opts.title='']
   * @param {Function} [opts.formatter]  - (item, indexOnPage) => string
   */
  constructor(items, { pageSize = 10, title = '', formatter = null } = {}) {
    if (!Array.isArray(items)) throw new Error('[PaginationHelper] items bir dizi olmalı');
    this._items     = items;
    this._pageSize  = Math.max(1, pageSize);
    this._title     = title;
    this._formatter = formatter || ((item) => String(item));
    this.total      = Math.ceil(items.length / this._pageSize) || 1;
  }

  /**
   * Belirtilen sayfayı döndürür.
   * @param {number} page - 0-indexed
   * @returns {{ content: string, current: number, total: number, hasNext: boolean, hasPrev: boolean }}
   */
  getPage(page = 0) {
    const p     = Math.max(0, Math.min(page, this.total - 1));
    const start = p * this._pageSize;
    const slice = this._items.slice(start, start + this._pageSize);

    const lines = [];
    if (this._title) lines.push(`**${this._title}** (${p + 1}/${this.total})`);
    lines.push('─────────────────────');
    slice.forEach((item, i) => lines.push(this._formatter(item, start + i)));
    if (this.total > 1) {
      lines.push('─────────────────────');
      const nav = [];
      if (p > 0)              nav.push(`◀ Önceki: sayfa ${p}`);
      if (p < this.total - 1) nav.push(`Sonraki: sayfa ${p + 2} ▶`);
      lines.push(nav.join('  ·  '));
    }

    return {
      content:  lines.join('\n'),
      current:  p,
      total:    this.total,
      hasNext:  p < this.total - 1,
      hasPrev:  p > 0,
    };
  }
}

// ── EXPORT ────────────────────────────────────────────────────
module.exports = { BridgeBot, MessageBuilder, EmbedBuilder, ButtonBuilder, PaginationHelper, BotStore, SDK_VERSION };

