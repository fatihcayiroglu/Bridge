/**
 * bridge-discord-shim
 * Discord.js v14 uyumlu katman — Bridge Bot SDK üzerine inşa edilmiştir.
 *
 * Mevcut Discord botları minimum değişiklikle Bridge'de çalıştırır.
 * Yalnızca Discord.js API'sini taklit eder; Discord'a hiç bağlanmaz.
 *
 * Desteklenen yüzey:
 *   Client, GatewayIntentBits, Message, Interaction,
 *   EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
 *   SlashCommandBuilder, Events
 *
 * Kullanım (mevcut Discord botu — sıfır değişiklik):
 *   const { Client, GatewayIntentBits } = require('bridge-discord-shim');
 *   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 *   client.login(process.env.DISCORD_TOKEN); // Bridge token kabul eder
 */

'use strict';

const { BridgeBot, EmbedBuilder: BridgeEmbed, ButtonBuilder: BridgeButton } = require('../bot-sdk/src/index.js');
const EventEmitter = require('eventemitter3');

// ── SABITLER ─────────────────────────────────────────────────

const GatewayIntentBits = {
  Guilds:                1 << 0,
  GuildMembers:          1 << 1,
  GuildMessages:         1 << 9,
  GuildMessageReactions: 1 << 10,
  DirectMessages:        1 << 12,
  MessageContent:        1 << 15,
};

const Events = {
  ClientReady:          'ready',
  MessageCreate:        'messageCreate',
  MessageUpdate:        'messageUpdate',
  MessageDelete:        'messageDelete',
  InteractionCreate:    'interactionCreate',
  GuildMemberAdd:       'guildMemberAdd',
  GuildMemberRemove:    'guildMemberRemove',
  ReactionAdd:          'messageReactionAdd',
};

const ButtonStyle = {
  Primary:   'primary',
  Secondary: 'secondary',
  Success:   'success',
  Danger:    'danger',
  Link:      'link',
};

const ApplicationCommandType = {
  ChatInput:  1,
  User:       2,
  Message:    3,
};

// ── YARDIMCI SINIFLAR ─────────────────────────────────────────

/**
 * Discord Message nesnesini taklit eder.
 * bridge_raw: Ham Bridge mesaj objesi
 */
class Message {
  constructor(raw, client) {
    this._raw    = raw;
    this._client = client;

    this.id        = raw._id || raw.id;
    this.content   = raw.content || '';
    this.channelId = raw.channelId;
    this.guildId   = raw.serverId;
    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();

    this.author = {
      id:       raw.userId || raw.author?.id,
      username: raw.username || raw.author?.username || 'unknown',
      bot:      raw.isBot || false,
      tag:      `${raw.username || 'unknown'}#0000`,
    };

    this.channel = {
      id:   raw.channelId,
      send: (content) => client._bot.sendMessage(raw.channelId, _resolveContent(content)),
    };

    this.guild = raw.serverId ? {
      id:   raw.serverId,
      name: raw.serverName || raw.serverId,
    } : null;

    // mentions.users — <@userId> pattern'lerini parse et
    this.mentions = {
      users: new Map(
        [...(raw.content || '').matchAll(/<@(\w+)>/g)].map(m => [m[1], { id: m[1] }])
      ),
      has: (user) => {
        const id = typeof user === 'string' ? user : user?.id;
        return this.mentions.users.has(id);
      },
    };
  }

  /** Discord Message#reply */
  async reply(content) {
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }

  /** Discord Message#delete */
  async delete() {
    return this._client._bot.deleteMessage(this.channelId, this.id);
  }

  /** Discord Message#react */
  async react(emoji) {
    return this._client._bot.addReaction(this.channelId, this.id, emoji);
  }

  /** Discord Message#edit */
  async edit(content) {
    return this._client._bot.editMessage(this.channelId, this.id, _resolveContent(content));
  }
}

/**
 * Discord ChatInputCommandInteraction (slash komut) taklit eder.
 */
class CommandInteraction {
  constructor(raw, client) {
    this._raw     = raw;
    this._client  = client;
    this._replied = false;

    this.id           = raw.interactionId || raw.id || `int_${Date.now()}`;
    this.commandName  = raw.command || raw.commandName || '';
    this.channelId    = raw.channelId;
    this.guildId      = raw.serverId;
    this.isChatInputCommand = () => true;
    this.isButton           = () => false;

    this.user = {
      id:       raw.userId,
      username: raw.username || 'unknown',
      tag:      `${raw.username || 'unknown'}#0000`,
    };

    this.member = {
      id:   raw.userId,
      user: this.user,
    };

    this.guild = raw.serverId ? { id: raw.serverId } : null;

    // Options API
    this.options = _buildOptions(raw.args || raw.options || []);
  }

  async reply(content) {
    this._replied = true;
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }

  async deferReply({ ephemeral = false } = {}) {
    this._replied = true;
    // Bridge'de defer yoktur — sadece işaretleriz
  }

  async editReply(content) {
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }

  async followUp(content) {
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }
}

/**
 * Discord ButtonInteraction taklit eder.
 */
class ButtonInteraction {
  constructor(raw, client) {
    this._raw    = raw;
    this._client = client;

    this.id           = raw.interactionId || `btn_${Date.now()}`;
    this.customId     = raw.customId;
    this.channelId    = raw.channelId;
    this.guildId      = raw.serverId;
    this.isButton     = () => true;
    this.isChatInputCommand = () => false;

    this.user = {
      id:       raw.userId,
      username: raw.username || 'unknown',
    };

    this.member = { id: raw.userId, user: this.user };
  }

  async reply(content) {
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }

  async deferUpdate() { /* no-op */ }

  async update(content) {
    return this._client._bot.sendMessage(this.channelId, _resolveContent(content));
  }
}

// ── EmbedBuilder (Discord API uyumlu) ────────────────────────

class EmbedBuilder {
  constructor() {
    this._data = {
      title: null, description: null,
      color: null, footer: null,
      fields: [], thumbnail: null, image: null,
      author: null, timestamp: null,
    };
  }

  setTitle(title)       { this._data.title = title;       return this; }
  setDescription(desc)  { this._data.description = desc;  return this; }
  setColor(color)       { this._data.color = color;       return this; }
  setFooter(opts)       {
    this._data.footer = typeof opts === 'string' ? { text: opts } : opts;
    return this;
  }
  setThumbnail(url)     { this._data.thumbnail = url;     return this; }
  setImage(url)         { this._data.image = url;         return this; }
  setTimestamp(ts)      { this._data.timestamp = ts || new Date(); return this; }
  setAuthor(opts)       { this._data.author = opts;       return this; }

  addFields(...fields) {
    const flat = fields.flat();
    this._data.fields.push(...flat);
    return this;
  }

  // Bridge markdown formatına dönüştür
  toMarkdown() {
    const b = new BridgeEmbed();
    if (this._data.title)       b.setTitle(this._data.title);
    if (this._data.description) b.setDescription(this._data.description);
    if (this._data.author?.name) {
      b.setDescription(`*${this._data.author.name}*\n${this._data.description || ''}`);
    }
    for (const f of this._data.fields) {
      b.addField(f.name, f.value, f.inline || false);
    }
    if (this._data.footer?.text) b.setFooter(this._data.footer.text);
    if (this._data.timestamp) {
      const ts = new Date(this._data.timestamp).toLocaleString('tr-TR');
      b.setFooter(`${this._data.footer?.text || ''} · ${ts}`.trim());
    }
    return b.build();
  }

  toJSON() { return this._data; }
}

// ── ActionRowBuilder / ButtonBuilder (Discord API uyumlu) ─────

class ButtonBuilder {
  constructor() {
    this._data = { customId: null, label: null, style: 'primary', disabled: false, url: null };
  }

  setCustomId(id)      { this._data.customId = id;      return this; }
  setLabel(label)      { this._data.label = label;       return this; }
  setStyle(style)      {
    // Discord ButtonStyle enum veya string
    const map = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
    this._data.style = map[style] || style;
    return this;
  }
  setDisabled(v)       { this._data.disabled = v;        return this; }
  setURL(url)          { this._data.url = url;            return this; }
  toJSON()             { return this._data; }
}

class ActionRowBuilder {
  constructor() { this._components = []; }

  addComponents(...components) {
    this._components.push(...components.flat());
    return this;
  }

  toJSON() {
    return {
      type: 'action_row',
      buttons: this._components.map(c => c.toJSON ? c.toJSON() : c),
    };
  }
}

// ── SlashCommandBuilder ───────────────────────────────────────

class SlashCommandBuilder {
  constructor() {
    this._name = '';
    this._description = '';
    this._options = [];
  }

  setName(name)               { this._name = name;               return this; }
  setDescription(desc)        { this._description = desc;         return this; }
  setDefaultMemberPermissions(p) { /* no-op */                    return this; }
  setDMPermission(v)          { /* no-op */                       return this; }

  addStringOption(fn)  { return this._addOption(fn, 'string');  }
  addIntegerOption(fn) { return this._addOption(fn, 'integer'); }
  addUserOption(fn)    { return this._addOption(fn, 'user');    }
  addBooleanOption(fn) { return this._addOption(fn, 'boolean'); }
  addChannelOption(fn) { return this._addOption(fn, 'channel'); }
  addRoleOption(fn)    { return this._addOption(fn, 'role');    }

  _addOption(fn, type) {
    const opt = fn(new _OptionBuilder(type));
    this._options.push(opt._data);
    return this;
  }

  toJSON() {
    return { name: this._name, description: this._description, options: this._options };
  }
}

class _OptionBuilder {
  constructor(type) { this._data = { type, name: '', description: '', required: false, choices: [] }; }
  setName(n)          { this._data.name = n;          return this; }
  setDescription(d)   { this._data.description = d;   return this; }
  setRequired(r)      { this._data.required = r;       return this; }
  addChoices(...choices) { this._data.choices.push(...choices.flat()); return this; }
  setMinValue(v)      { this._data.min = v;            return this; }
  setMaxValue(v)      { this._data.max = v;            return this; }
  setAutocomplete(v)  { /* no-op */                    return this; }
}

// ── REST & Routes (kayıt için no-op) ─────────────────────────

class REST {
  constructor() { this._token = null; }
  setToken(token) { this._token = token; return this; }
  async put(route, { body } = {}) {
    // Bridge'de slash komutlar bot.command() ile kaydedilir;
    // REST kayıt no-op — ama geliştirici beklemeden geçmeli.
    console.log(`[bridge-discord-shim] REST.put ${route} — Bridge'de komutlar otomatik kaydedilir.`);
    return [];
  }
}

const Routes = {
  applicationCommands: (appId)            => `/applications/${appId}/commands`,
  applicationGuildCommands: (appId, gId)  => `/applications/${appId}/guilds/${gId}/commands`,
};

// ── Ana CLIENT ────────────────────────────────────────────────

class Client extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number[]} opts.intents       - GatewayIntentBits dizisi (Bridge'de görmezden gelinir)
   * @param {string}   [opts.serverUrl]   - Bridge sunucu URL'i (varsayılan: BRIDGE_URL env)
   */
  constructor({ intents = [], serverUrl } = {}) {
    super();

    this._intents   = intents;
    this._serverUrl = serverUrl || process.env.BRIDGE_URL || 'http://localhost:3001';
    this._bot       = null;
    this._commands  = new Map(); // name → handler
    this._readyAt   = null;

    // Discord Client.user mock
    this.user = null;

    // application mock (REST kayıt için)
    this.application = { id: 'bridge-app' };

    // guilds collection mock
    this.guilds = {
      cache: new Map(),
      fetch: async (id) => ({ id, name: id }),
    };
  }

  /** Discord Client#login — Bridge token kabul eder */
  async login(token) {
    const resolvedToken = token || process.env.BRIDGE_TOKEN || process.env.BOT_TOKEN;
    if (!resolvedToken) throw new Error('[bridge-discord-shim] Token bulunamadı. BRIDGE_TOKEN veya DISCORD_TOKEN env değişkenini ayarlayın.');

    this._bot = new BridgeBot({
      token:     resolvedToken,
      serverUrl: this._serverUrl,
      debug:     process.env.BRIDGE_DEBUG === 'true',
    });

    this._bindEvents();
    await this._bot.connect();
    return resolvedToken;
  }

  /** Discord Client#destroy */
  destroy() {
    this._bot?.disconnect();
  }

  // ── Event Binding ───────────────────────────────────────────

  _bindEvents() {
    const bot = this._bot;

    bot.on('ready', (info) => {
      this.user = {
        id:       info._id || info.id,
        username: info.username,
        tag:      `${info.username}#0000`,
        bot:      true,
      };
      this._readyAt = new Date();
      // Discord: client.once(Events.ClientReady, c => ...)
      this.emit('ready', this);
    });

    bot.on('message', (raw) => {
      const msg = new Message(raw, this);
      this.emit('messageCreate', msg);
    });

    bot.on('messageEdit', (raw) => {
      const msg = new Message(raw, this);
      this.emit('messageUpdate', null, msg);
    });

    bot.on('messageDelete', (raw) => {
      this.emit('messageDelete', { id: raw.messageId, channelId: raw.channelId });
    });

    bot.on('reaction', (raw) => {
      this.emit('messageReactionAdd', {
        emoji:     { name: raw.emoji },
        message:   { id: raw.messageId, channelId: raw.channelId },
        userId:    raw.userId,
      });
    });

    bot.on('memberJoin', (raw) => {
      this.emit('guildMemberAdd', { id: raw.userId, guild: { id: raw.serverId } });
    });

    bot.on('memberLeave', (raw) => {
      this.emit('guildMemberRemove', { id: raw.userId, guild: { id: raw.serverId } });
    });

    bot.on('interaction', (raw) => {
      let interaction;
      if (raw.type === 'slash' || raw.type === 'command') {
        interaction = new CommandInteraction(raw, this);
      } else if (raw.type === 'button') {
        interaction = new ButtonInteraction(raw, this);
      } else {
        interaction = new CommandInteraction(raw, this);
      }
      this.emit('interactionCreate', interaction);
    });

    // Slash komutları Bridge'e kaydet
    bot.on('ready', () => {
      for (const [name, { description, handler }] of this._commands) {
        bot.command(name, { description, handler: (ctx) => handler(_ctxToInteraction(ctx, this)) });
      }
    });
  }

  // ── commands.set shim ────────────────────────────────────────
  // Discord botları genellikle client.commands = new Collection() kullanır.
  // Burada Map uyumlu koleksiyonu döndürürüz.
  get commands() {
    if (!this._commandsProxy) {
      this._commandsProxy = new _BridgeCollection();
    }
    return this._commandsProxy;
  }
}

// ── Collection (Discord.js Collection mock) ───────────────────

class _BridgeCollection extends Map {
  find(fn) {
    for (const [, val] of this) {
      if (fn(val)) return val;
    }
    return undefined;
  }

  filter(fn) {
    const result = new _BridgeCollection();
    for (const [key, val] of this) {
      if (fn(val)) result.set(key, val);
    }
    return result;
  }

  map(fn) {
    return [...this.values()].map(fn);
  }

  some(fn) {
    return [...this.values()].some(fn);
  }

  every(fn) {
    return [...this.values()].every(fn);
  }

  first() {
    return this.values().next().value;
  }

  last() {
    const vals = [...this.values()];
    return vals[vals.length - 1];
  }

  toJSON() {
    return Object.fromEntries(this);
  }
}

// ── YARDIMCI FONKSİYONLAR ────────────────────────────────────

/** İçerik objesini string'e dönüştür */
function _resolveContent(content) {
  if (typeof content === 'string') return content;
  if (content instanceof EmbedBuilder) return content.toMarkdown();
  if (content?.embeds?.[0] instanceof EmbedBuilder) {
    const parts = [];
    if (content.content) parts.push(content.content);
    for (const e of content.embeds) parts.push(e.toMarkdown());
    return parts.join('\n\n');
  }
  if (content?.content) {
    const parts = [content.content];
    if (content.embeds) {
      for (const e of content.embeds) {
        parts.push(e instanceof EmbedBuilder ? e.toMarkdown() : JSON.stringify(e));
      }
    }
    return parts.join('\n\n');
  }
  return String(content);
}

/** Bridge ctx nesnesini Discord Interaction'a dönüştür */
function _ctxToInteraction(ctx, client) {
  return new CommandInteraction({
    interactionId: `ctx_${Date.now()}`,
    command:       ctx.command || '',
    commandName:   ctx.command || '',
    channelId:     ctx.channelId,
    serverId:      ctx.serverId,
    userId:        ctx.userId,
    username:      ctx.username,
    args:          ctx.args || [],
    options:       ctx.options || [],
  }, client);
}

/** Args dizisini Discord Options API'sine dönüştür */
function _buildOptions(args) {
  const map = new Map();
  const indexed = [];

  for (let i = 0; i < args.length; i++) {
    indexed.push(args[i]);
  }

  return {
    getString:  (name, req) => _getOptionValue(args, name, 'string', req),
    getInteger: (name, req) => _getOptionValue(args, name, 'integer', req),
    getUser:    (name, req) => _getOptionValue(args, name, 'user', req),
    getBoolean: (name, req) => _getOptionValue(args, name, 'boolean', req),
    getChannel: (name, req) => _getOptionValue(args, name, 'channel', req),
    getRole:    (name, req) => _getOptionValue(args, name, 'role', req),
    get:        (name)      => args[0] || null,
    data:       args,
  };
}

function _getOptionValue(args, name, type, required) {
  // Önce key=value formatı: args = ["name:value", ...]
  const kvPair = args.find(a => typeof a === 'string' && a.startsWith(`${name}:`));
  if (kvPair) {
    const val = kvPair.slice(name.length + 1);
    return type === 'integer' ? parseInt(val) : type === 'boolean' ? val === 'true' : val;
  }
  // Objeyse doğrudan al
  const obj = args.find(a => a && typeof a === 'object' && a.name === name);
  if (obj) return obj.value;
  // Fallback: pozisyonel
  return args[0] || (required ? null : null);
}

// ── EXPORT ───────────────────────────────────────────────────

module.exports = {
  // Ana sınıflar
  Client,
  REST,
  Routes,

  // Builder'lar
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  SlashCommandBuilder,

  // Collection
  Collection: _BridgeCollection,

  // Enum'lar
  GatewayIntentBits,
  Events,
  ButtonStyle,
  ApplicationCommandType,

  // Yardımcı
  _resolveContent,
};
