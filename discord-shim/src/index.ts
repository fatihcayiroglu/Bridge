/**
 * bridge-discord-shim — index.ts
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
 *   import { Client, GatewayIntentBits } from 'bridge-discord-shim';
 *   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 *   client.login(process.env.DISCORD_TOKEN); // Bridge token kabul eder
 */

'use strict';

import EventEmitter from 'eventemitter3';

// Bot SDK — JS modülü, tipler manuel tanımlanır
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  BridgeBot,
  EmbedBuilder: BridgeEmbed,
  ButtonBuilder: BridgeButton,
} = require('../bot-sdk/src/index.js') as {
  BridgeBot: new (opts: BridgeBotOptions) => BridgeBotInstance;
  EmbedBuilder: new () => BridgeEmbedInstance;
  ButtonBuilder: new () => unknown;
};

// ── Bot SDK tip tanımları ─────────────────────────────────────────────────────

interface BridgeBotOptions {
  token: string;
  serverUrl: string;
  debug?: boolean;
}

type BridgeBotEventName =
  | 'ready' | 'message' | 'messageEdit' | 'messageDelete'
  | 'reaction' | 'memberJoin' | 'memberLeave' | 'interaction';

interface BridgeBotInstance {
  connect(): Promise<void>;
  disconnect(): void;
  on(event: BridgeBotEventName, handler: (data: RawPayload) => void): void;
  command(name: string, opts: { description: string; handler: (ctx: RawPayload) => void }): void;
  sendMessage(channelId: string, content: string): Promise<unknown>;
  deleteMessage(channelId: string, messageId: string): Promise<unknown>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<unknown>;
  editMessage(channelId: string, messageId: string, content: string): Promise<unknown>;
}

interface BridgeEmbedInstance {
  setTitle(t: string): this;
  setDescription(d: string): this;
  addField(name: string, value: string, inline: boolean): this;
  setFooter(text: string): this;
  build(): string;
}

// ── Ham payload tipleri ───────────────────────────────────────────────────────

interface RawPayload {
  _id?: string;
  id?: string;
  content?: string;
  channelId?: string;
  serverId?: string;
  serverName?: string;
  userId?: string;
  username?: string;
  isBot?: boolean;
  author?: { id: string; username: string };
  createdAt?: string | number;
  messageId?: string;
  emoji?: string;
  interactionId?: string;
  command?: string;
  commandName?: string;
  args?: OptionArg[];
  options?: OptionArg[];
  customId?: string;
  type?: 'slash' | 'command' | 'button' | string;
}

type OptionArg = string | { name: string; value: unknown };

// ── SABITLER ─────────────────────────────────────────────────────────────────

export const GatewayIntentBits = {
  Guilds:                1 << 0,
  GuildMembers:          1 << 1,
  GuildMessages:         1 << 9,
  GuildMessageReactions: 1 << 10,
  DirectMessages:        1 << 12,
  MessageContent:        1 << 15,
} as const;

export const Events = {
  ClientReady:          'ready',
  MessageCreate:        'messageCreate',
  MessageUpdate:        'messageUpdate',
  MessageDelete:        'messageDelete',
  InteractionCreate:    'interactionCreate',
  GuildMemberAdd:       'guildMemberAdd',
  GuildMemberRemove:    'guildMemberRemove',
  ReactionAdd:          'messageReactionAdd',
} as const;

export const ButtonStyle = {
  Primary:   'primary',
  Secondary: 'secondary',
  Success:   'success',
  Danger:    'danger',
  Link:      'link',
} as const;
export type ButtonStyleValue = typeof ButtonStyle[keyof typeof ButtonStyle];

export const ApplicationCommandType = {
  ChatInput: 1,
  User:      2,
  Message:   3,
} as const;

// ── YARDIMCI SINIFLAR ─────────────────────────────────────────────────────────

/** Discord Message nesnesini taklit eder. */
export class Message {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly guildId: string | undefined;
  readonly createdAt: Date;
  readonly author: { id: string; username: string; bot: boolean; tag: string };
  readonly channel: { id: string; send: (content: MessageContent) => Promise<unknown> };
  readonly guild: { id: string; name: string } | null;
  readonly mentions: {
    users: Map<string, { id: string }>;
    has: (user: string | { id?: string }) => boolean;
  };

  private readonly _raw: RawPayload;
  private readonly _client: Client;

  constructor(raw: RawPayload, client: Client) {
    this._raw    = raw;
    this._client = client;

    this.id        = raw._id ?? raw.id ?? '';
    this.content   = raw.content ?? '';
    this.channelId = raw.channelId ?? '';
    this.guildId   = raw.serverId;
    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();

    this.author = {
      id:       raw.userId ?? raw.author?.id ?? '',
      username: raw.username ?? raw.author?.username ?? 'unknown',
      bot:      raw.isBot ?? false,
      tag:      `${raw.username ?? 'unknown'}#0000`,
    };

    this.channel = {
      id:   raw.channelId ?? '',
      send: (content: MessageContent) =>
        client._bot!.sendMessage(raw.channelId ?? '', _resolveContent(content)),
    };

    this.guild = raw.serverId
      ? { id: raw.serverId, name: raw.serverName ?? raw.serverId }
      : null;

    const userMatches = [...(raw.content ?? '').matchAll(/<@(\w+)>/g)];
    this.mentions = {
      users: new Map(userMatches.map((m) => [m[1], { id: m[1] }])),
      has: (user: string | { id?: string }) => {
        const id = typeof user === 'string' ? user : user?.id ?? '';
        return this.mentions.users.has(id);
      },
    };
  }

  async reply(content: MessageContent): Promise<unknown> {
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
  async delete(): Promise<unknown> {
    return this._client._bot!.deleteMessage(this.channelId, this.id);
  }
  async react(emoji: string): Promise<unknown> {
    return this._client._bot!.addReaction(this.channelId, this.id, emoji);
  }
  async edit(content: MessageContent): Promise<unknown> {
    return this._client._bot!.editMessage(this.channelId, this.id, _resolveContent(content));
  }
}

/** Discord ChatInputCommandInteraction (slash komut) taklit eder. */
export class CommandInteraction {
  readonly id: string;
  readonly commandName: string;
  readonly channelId: string;
  readonly guildId: string | undefined;
  readonly user: { id: string; username: string; tag: string };
  readonly member: { id: string; user: CommandInteraction['user'] };
  readonly guild: { id: string } | null;
  readonly options: ReturnType<typeof _buildOptions>;
  readonly isChatInputCommand: () => boolean;
  readonly isButton:           () => boolean;

  private _replied = false;
  private readonly _client: Client;

  constructor(raw: RawPayload, client: Client) {
    this._client = client;

    this.id          = raw.interactionId ?? raw.id ?? `int_${Date.now()}`;
    this.commandName = raw.command ?? raw.commandName ?? '';
    this.channelId   = raw.channelId ?? '';
    this.guildId     = raw.serverId;

    this.isChatInputCommand = () => true;
    this.isButton           = () => false;

    this.user = {
      id:       raw.userId ?? '',
      username: raw.username ?? 'unknown',
      tag:      `${raw.username ?? 'unknown'}#0000`,
    };
    this.member = { id: raw.userId ?? '', user: this.user };
    this.guild  = raw.serverId ? { id: raw.serverId } : null;
    this.options = _buildOptions(raw.args ?? raw.options ?? []);
  }

  async reply(content: MessageContent): Promise<unknown> {
    this._replied = true;
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
  async deferReply(_opts: { ephemeral?: boolean } = {}): Promise<void> {
    this._replied = true;
  }
  async editReply(content: MessageContent): Promise<unknown> {
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
  async followUp(content: MessageContent): Promise<unknown> {
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
}

/** Discord ButtonInteraction taklit eder. */
export class ButtonInteraction {
  readonly id: string;
  readonly customId: string;
  readonly channelId: string;
  readonly guildId: string | undefined;
  readonly user: { id: string; username: string };
  readonly member: { id: string; user: ButtonInteraction['user'] };
  readonly isChatInputCommand: () => boolean;
  readonly isButton:           () => boolean;

  private readonly _client: Client;

  constructor(raw: RawPayload, client: Client) {
    this._client = client;

    this.id        = raw.interactionId ?? `btn_${Date.now()}`;
    this.customId  = raw.customId ?? '';
    this.channelId = raw.channelId ?? '';
    this.guildId   = raw.serverId;

    this.isChatInputCommand = () => false;
    this.isButton           = () => true;

    this.user   = { id: raw.userId ?? '', username: raw.username ?? 'unknown' };
    this.member = { id: raw.userId ?? '', user: this.user };
  }

  async reply(content: MessageContent): Promise<unknown> {
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
  async deferUpdate(): Promise<void> { /* no-op */ }
  async update(content: MessageContent): Promise<unknown> {
    return this._client._bot!.sendMessage(this.channelId, _resolveContent(content));
  }
}

// ── EmbedBuilder ─────────────────────────────────────────────────────────────

interface EmbedField   { name: string; value: string; inline?: boolean }
interface EmbedFooter  { text: string; iconURL?: string }
interface EmbedAuthor  { name: string; iconURL?: string; url?: string }

interface EmbedData {
  title:       string | null;
  description: string | null;
  color:       number | string | null;
  footer:      EmbedFooter | null;
  fields:      EmbedField[];
  thumbnail:   string | null;
  image:       string | null;
  author:      EmbedAuthor | null;
  timestamp:   Date | string | number | null;
}

export class EmbedBuilder {
  private _data: EmbedData = {
    title: null, description: null, color: null,
    footer: null, fields: [], thumbnail: null,
    image: null, author: null, timestamp: null,
  };

  setTitle(title: string):       this { this._data.title = title;       return this; }
  setDescription(desc: string):  this { this._data.description = desc;  return this; }
  setColor(color: number | string): this { this._data.color = color;    return this; }
  setFooter(opts: string | EmbedFooter): this {
    this._data.footer = typeof opts === 'string' ? { text: opts } : opts;
    return this;
  }
  setThumbnail(url: string): this  { this._data.thumbnail = url;  return this; }
  setImage(url: string): this      { this._data.image = url;      return this; }
  setTimestamp(ts?: Date | number | null): this {
    this._data.timestamp = ts ?? new Date();
    return this;
  }
  setAuthor(opts: EmbedAuthor): this { this._data.author = opts; return this; }
  addFields(...fields: (EmbedField | EmbedField[])[]): this {
    this._data.fields.push(...fields.flat());
    return this;
  }

  toMarkdown(): string {
    const b: BridgeEmbedInstance = new BridgeEmbed();
    if (this._data.title)       b.setTitle(this._data.title);
    if (this._data.description) b.setDescription(this._data.description);
    if (this._data.author?.name) {
      b.setDescription(`*${this._data.author.name}*\n${this._data.description ?? ''}`);
    }
    for (const f of this._data.fields) {
      b.addField(f.name, f.value, f.inline ?? false);
    }
    if (this._data.footer?.text) b.setFooter(this._data.footer.text);
    if (this._data.timestamp) {
      const ts = new Date(this._data.timestamp as string).toLocaleString('tr-TR');
      b.setFooter(`${this._data.footer?.text ?? ''} · ${ts}`.trim());
    }
    return b.build();
  }

  toJSON(): EmbedData { return this._data; }
}

// ── ActionRowBuilder / ButtonBuilder ─────────────────────────────────────────

interface ButtonData {
  customId: string | null;
  label:    string | null;
  style:    string;
  disabled: boolean;
  url:      string | null;
}

export class ButtonBuilder {
  private _data: ButtonData = { customId: null, label: null, style: 'primary', disabled: false, url: null };

  setCustomId(id: string):    this { this._data.customId = id;  return this; }
  setLabel(label: string):    this { this._data.label = label;  return this; }
  setStyle(style: number | ButtonStyleValue): this {
    const map: Record<number, string> = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
    this._data.style = typeof style === 'number' ? (map[style] ?? 'primary') : style;
    return this;
  }
  setDisabled(v: boolean): this { this._data.disabled = v; return this; }
  setURL(url: string):     this { this._data.url = url;    return this; }
  toJSON(): ButtonData          { return this._data; }
}

export class ActionRowBuilder {
  private _components: ButtonBuilder[] = [];

  addComponents(...components: (ButtonBuilder | ButtonBuilder[])[]): this {
    this._components.push(...components.flat());
    return this;
  }

  toJSON(): { type: string; buttons: ButtonData[] } {
    return {
      type:    'action_row',
      buttons: this._components.map((c) => c.toJSON()),
    };
  }
}

// ── SlashCommandBuilder ───────────────────────────────────────────────────────

interface OptionData {
  type:        string;
  name:        string;
  description: string;
  required:    boolean;
  choices:     unknown[];
  min?:        number;
  max?:        number;
}

class _OptionBuilder {
  _data: OptionData;
  constructor(type: string) {
    this._data = { type, name: '', description: '', required: false, choices: [] };
  }
  setName(n: string):         this { this._data.name = n;         return this; }
  setDescription(d: string):  this { this._data.description = d;  return this; }
  setRequired(r: boolean):    this { this._data.required = r;     return this; }
  addChoices(...choices: unknown[]): this { this._data.choices.push(...choices.flat()); return this; }
  setMinValue(v: number):     this { this._data.min = v;          return this; }
  setMaxValue(v: number):     this { this._data.max = v;          return this; }
  setAutocomplete(_v: boolean): this { return this; }
}

export class SlashCommandBuilder {
  private _name        = '';
  private _description = '';
  private _options: OptionData[] = [];

  setName(name: string):        this { this._name = name;              return this; }
  setDescription(desc: string): this { this._description = desc;       return this; }
  setDefaultMemberPermissions(_p: unknown): this { return this; }
  setDMPermission(_v: boolean): this { return this; }

  addStringOption( fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'string');  }
  addIntegerOption(fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'integer'); }
  addUserOption(   fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'user');    }
  addBooleanOption(fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'boolean'); }
  addChannelOption(fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'channel'); }
  addRoleOption(   fn: (b: _OptionBuilder) => _OptionBuilder): this { return this._addOption(fn, 'role');    }

  private _addOption(fn: (b: _OptionBuilder) => _OptionBuilder, type: string): this {
    const opt = fn(new _OptionBuilder(type));
    this._options.push(opt._data);
    return this;
  }

  toJSON(): { name: string; description: string; options: OptionData[] } {
    return { name: this._name, description: this._description, options: this._options };
  }
}

// ── REST & Routes ─────────────────────────────────────────────────────────────

export class REST {
  private _token: string | null = null;

  setToken(token: string): this { this._token = token; return this; }

  async put(route: string, _opts: { body?: unknown } = {}): Promise<unknown[]> {
    console.log(`[bridge-discord-shim] REST.put ${route} — Bridge'de komutlar otomatik kaydedilir.`);
    return [];
  }
}

export const Routes = {
  applicationCommands:      (appId: string)              => `/applications/${appId}/commands`,
  applicationGuildCommands: (appId: string, gId: string) => `/applications/${appId}/guilds/${gId}/commands`,
};

// ── Collection (Discord.js Collection mock) ───────────────────────────────────

export class Collection<K, V> extends Map<K, V> {
  find(fn: (v: V) => boolean): V | undefined {
    for (const [, val] of this) { if (fn(val)) return val; }
    return undefined;
  }
  filter(fn: (v: V) => boolean): Collection<K, V> {
    const result = new Collection<K, V>();
    for (const [key, val] of this) { if (fn(val)) result.set(key, val); }
    return result;
  }
  map<T>(fn: (v: V) => T): T[]            { return [...this.values()].map(fn); }
  some(fn: (v: V) => boolean): boolean     { return [...this.values()].some(fn); }
  every(fn: (v: V) => boolean): boolean    { return [...this.values()].every(fn); }
  first(): V | undefined                   { return this.values().next().value; }
  last():  V | undefined                   { const vs = [...this.values()]; return vs[vs.length - 1]; }
  toJSON(): Record<string, V>              { return Object.fromEntries(this) as Record<string, V>; }
}

// ── Ana CLIENT ────────────────────────────────────────────────────────────────

export interface ClientOptions {
  intents?: number[];
  serverUrl?: string;
}

type MessageContent = string | EmbedBuilder | {
  content?: string;
  embeds?: (EmbedBuilder | unknown)[];
};

export class Client extends EventEmitter {
  user: { id: string; username: string; tag: string; bot: boolean } | null = null;
  application: { id: string } = { id: 'bridge-app' };
  guilds: { cache: Collection<string, unknown>; fetch: (id: string) => Promise<{ id: string; name: string }> };

  _bot: BridgeBotInstance | null = null;

  private readonly _intents:   number[];
  private readonly _serverUrl: string;
  private _readyAt: Date | null = null;
  private _commandsProxy?: Collection<string, unknown>;

  constructor({ intents = [], serverUrl }: ClientOptions = {}) {
    super();
    this._intents   = intents;
    this._serverUrl = serverUrl ?? process.env['BRIDGE_URL'] ?? 'http://localhost:3001';
    this.guilds     = {
      cache: new Collection(),
      fetch: async (id: string) => ({ id, name: id }),
    };
  }

  async login(token?: string): Promise<string> {
    const resolvedToken = token ?? process.env['BRIDGE_TOKEN'] ?? process.env['BOT_TOKEN'];
    if (!resolvedToken) {
      throw new Error('[bridge-discord-shim] Token bulunamadı. BRIDGE_TOKEN veya DISCORD_TOKEN env değişkenini ayarlayın.');
    }

    this._bot = new BridgeBot({
      token:     resolvedToken,
      serverUrl: this._serverUrl,
      debug:     process.env['BRIDGE_DEBUG'] === 'true',
    });

    this._bindEvents();
    await this._bot.connect();
    return resolvedToken;
  }

  destroy(): void { this._bot?.disconnect(); }

  get commands(): Collection<string, unknown> {
    this._commandsProxy ??= new Collection();
    return this._commandsProxy;
  }

  private _bindEvents(): void {
    const bot = this._bot!;

    bot.on('ready', (info: RawPayload) => {
      this.user = {
        id:       info._id ?? info.id ?? '',
        username: info.username ?? '',
        tag:      `${info.username ?? ''}#0000`,
        bot:      true,
      };
      this._readyAt = new Date();
      this.emit('ready', this);
    });

    bot.on('message',      (raw) => this.emit('messageCreate',    new Message(raw, this)));
    bot.on('messageEdit',  (raw) => this.emit('messageUpdate',    null, new Message(raw, this)));
    bot.on('messageDelete',(raw) => this.emit('messageDelete',    { id: raw.messageId, channelId: raw.channelId }));

    bot.on('reaction', (raw) => {
      this.emit('messageReactionAdd', {
        emoji:   { name: raw.emoji },
        message: { id: raw.messageId, channelId: raw.channelId },
        userId:  raw.userId,
      });
    });

    bot.on('memberJoin',  (raw) => this.emit('guildMemberAdd',    { id: raw.userId, guild: { id: raw.serverId } }));
    bot.on('memberLeave', (raw) => this.emit('guildMemberRemove', { id: raw.userId, guild: { id: raw.serverId } }));

    bot.on('interaction', (raw: RawPayload) => {
      const interaction = raw.type === 'button'
        ? new ButtonInteraction(raw, this)
        : new CommandInteraction(raw, this);
      this.emit('interactionCreate', interaction);
    });

    bot.on('ready', () => {
      this._commandsProxy?.forEach((_handler, name) => {
        // Kayıt isteği geldiğinde bridge'e komut tanımla
        bot.command(name as string, {
          description: '',
          handler: (ctx: RawPayload) => {
            const interaction = _ctxToInteraction(ctx, this);
            this.emit('interactionCreate', interaction);
          },
        });
      });
    });
  }
}

// ── YARDIMCI FONKSİYONLAR ────────────────────────────────────────────────────

function _resolveContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (content instanceof EmbedBuilder) return content.toMarkdown();
  if (typeof content === 'object' && content !== null) {
    const parts: string[] = [];
    if ('content' in content && content.content) parts.push(content.content);
    if ('embeds' in content && Array.isArray(content.embeds)) {
      for (const e of content.embeds) {
        parts.push(e instanceof EmbedBuilder ? e.toMarkdown() : JSON.stringify(e));
      }
    }
    return parts.join('\n\n');
  }
  return String(content);
}

function _ctxToInteraction(ctx: RawPayload, client: Client): CommandInteraction {
  return new CommandInteraction({
    interactionId: `ctx_${Date.now()}`,
    command:       ctx.command ?? '',
    commandName:   ctx.command ?? '',
    channelId:     ctx.channelId,
    serverId:      ctx.serverId,
    userId:        ctx.userId,
    username:      ctx.username,
    args:          ctx.args ?? [],
    options:       ctx.options ?? [],
  }, client);
}

function _buildOptions(args: OptionArg[]): {
  getString:  (name: string, required?: boolean) => unknown;
  getInteger: (name: string, required?: boolean) => unknown;
  getUser:    (name: string, required?: boolean) => unknown;
  getBoolean: (name: string, required?: boolean) => unknown;
  getChannel: (name: string, required?: boolean) => unknown;
  getRole:    (name: string, required?: boolean) => unknown;
  get:        (name: string) => OptionArg | null;
  data:       OptionArg[];
} {
  return {
    getString:  (n, r) => _getOptionValue(args, n, 'string',  r),
    getInteger: (n, r) => _getOptionValue(args, n, 'integer', r),
    getUser:    (n, r) => _getOptionValue(args, n, 'user',    r),
    getBoolean: (n, r) => _getOptionValue(args, n, 'boolean', r),
    getChannel: (n, r) => _getOptionValue(args, n, 'channel', r),
    getRole:    (n, r) => _getOptionValue(args, n, 'role',    r),
    get:        (_n)   => args[0] ?? null,
    data:       args,
  };
}

function _getOptionValue(
  args: OptionArg[], name: string, type: string, _required?: boolean,
): unknown {
  const kvPair = args.find((a): a is string => typeof a === 'string' && a.startsWith(`${name}:`));
  if (kvPair) {
    const val = kvPair.slice(name.length + 1);
    if (type === 'integer') return parseInt(val, 10);
    if (type === 'boolean') return val === 'true';
    return val;
  }
  const obj = args.find((a): a is { name: string; value: unknown } =>
    typeof a === 'object' && a !== null && 'name' in a && (a as { name: string }).name === name,
  );
  if (obj) return obj.value;
  return args[0] ?? null;
}
