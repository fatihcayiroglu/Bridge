// server/middleware/validate.ts
// Lightweight input validation middleware (no external deps)
// nested object validation, boolean type, sanitize option

import { Request, Response, NextFunction } from 'express';
import { escapeHtml } from '../lib/security';
import { VALID_BITS } from '../lib/permissions';

export type FieldType = 'string' | 'number' | 'array' | 'object' | 'boolean';

export interface FieldRules {
  type?: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: string[];
  each?: FieldRules | string;
  shape?: Schema;
  sanitize?: boolean;
}

export type Schema = Record<string, FieldRules>;

/**
 * validateBody(schema) — Express middleware
 * schema: { field: { type, required, min, max, pattern, enum, each, shape } }
 * type: 'string' | 'number' | 'array' | 'object' | 'boolean'
 * shape: schema for nested objects (type:'object')
 * each: { type, ... } for array item validation (supports objects via shape)
 */
export function validateField(
  path: string,
  val: unknown,
  rules: FieldRules,
  errors: string[]
): void {
  const missing = val === undefined || val === null || val === '';

  if (rules.required && missing) { errors.push(`${path} is required`); return; }
  if (missing) return;

  if (rules.type === 'boolean') {
    if (typeof val !== 'boolean') errors.push(`${path} must be a boolean`);
    return;
  }

  if (rules.type === 'string') {
    if (typeof val !== 'string') { errors.push(`${path} must be a string`); return; }
    const s = rules.sanitize ? escapeHtml(val.trim()) : val.trim();
    if (rules.min !== undefined && s.length < rules.min) errors.push(`${path} must be at least ${rules.min} characters`);
    if (rules.max !== undefined && s.length > rules.max) errors.push(`${path} must be at most ${rules.max} characters`);
    if (rules.pattern && !rules.pattern.test(s)) errors.push(`${path} has invalid format`);
    if (rules.enum && !rules.enum.includes(s)) errors.push(`${path} must be one of: ${rules.enum.join(', ')}`);
    return;
  }

  if (rules.type === 'number') {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      errors.push(`${path} must be a number`); return;
    }
    if (rules.min !== undefined && val < rules.min) errors.push(`${path} must be >= ${rules.min}`);
    if (rules.max !== undefined && val > rules.max) errors.push(`${path} must be <= ${rules.max}`);
    return;
  }

  if (rules.type === 'array') {
    if (!Array.isArray(val)) { errors.push(`${path} must be an array`); return; }
    if (rules.min !== undefined && val.length < rules.min) errors.push(`${path} must have at least ${rules.min} items`);
    if (rules.max !== undefined && val.length > rules.max) errors.push(`${path} too many items (max ${rules.max})`);
    if (rules.each) {
      val.forEach((item, i) => {
        if (typeof rules.each === 'string') {
          if (typeof item !== rules.each) errors.push(`${path}[${i}] must be ${rules.each}`);
        } else if (rules.each && typeof rules.each === 'object') {
          validateField(`${path}[${i}]`, item, rules.each as FieldRules, errors);
        }
      });
    }
    return;
  }

  if (rules.type === 'object') {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      errors.push(`${path} must be an object`); return;
    }
    if (rules.shape) {
      for (const [subField, subRules] of Object.entries(rules.shape)) {
        validateField(`${path}.${subField}`, (val as Record<string, unknown>)[subField], subRules, errors);
      }
    }
    return;
  }
}

export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];
    for (const [field, rules] of Object.entries(schema)) {
      validateField(field, (req.body as Record<string, unknown>)[field], rules, errors);
      if (!errors.length && rules?.type === 'string' && rules?.sanitize && typeof (req.body as Record<string, unknown>)[field] === 'string') {
        (req.body as Record<string, unknown>)[field] = escapeHtml(((req.body as Record<string, unknown>)[field] as string).trim());
      }
    }
    if (errors.length) { res.status(400).json({ error: errors[0], errors }); return; }
    next();
  };
}

// Common schemas
// `Record<string, Schema>` ANNOTASYONU, `noUncheckedIndexedAccess` altında
// her erişimi `Schema | undefined` yapıyordu — oysa buradaki anahtarlar
// SABİTTİR ve `schemas.register` her zaman vardır. `satisfies` hem
// değerleri şemaya karşı doğrular hem de anahtarları KESİN tutar; yani
// yazım hatası olan bir anahtar (`schemas.registr`) derleme hatası olur.
export const schemas = {
  message: {
    content: { type: 'string', required: true, min: 1, max: 2000 },
  },
  register: {
    username: { type: 'string', required: true, min: 3, max: 32, pattern: /^[a-zA-Z0-9_]+$/ },
    password: { type: 'string', required: true, min: 8, max: 128 },
  },
  login: {
    username: { type: 'string', required: true, min: 3, max: 32 },
    password: { type: 'string', required: true, min: 1, max: 128 },
  },
  changePassword: {
    currentPassword: { type: 'string', required: true, min: 1, max: 128 },
    newPassword: { type: 'string', required: true, min: 8, max: 128 },
  },
  createServer: {
    name: { type: 'string', required: true, min: 1, max: 50 },
  },
  createChannel: {
    name: { type: 'string', required: true, min: 1, max: 32 },
    type: { type: 'string', required: true, enum: ['text', 'voice'] },
  },
  createRole: {
    name: { type: 'string', required: true, min: 1, max: 32 },
  },
  createBot: {
    name:        { type: 'string', required: true, min: 1, max: 50 },
    description: { type: 'string', max: 200 },
  },
  createWebhook: {
    name:   { type: 'string', required: true, min: 1, max: 50 },
    events: { type: 'array', max: 20, each: { type: 'string', max: 64 } },
  },
} satisfies Record<string, Schema>;

export interface BitmaskPair {
  allow?: string;
  deny?: string;
}

/**
 * validateBitmaskMiddleware(target?) — Express middleware
 * Bitmask allow/deny değerlerini merkezi olarak doğrular.
 */
export function validateBitmaskMiddleware(target?: string | BitmaskPair[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown>;

    if (typeof target === 'string') {
      const items = body[target];
      if (!Array.isArray(items)) { next(); return; }
      for (let i = 0; i < items.length; i++) {
        const item = items[i] as Record<string, unknown>;
        const rawA = item.allow ?? 0;
        const rawD = item.deny ?? 0;
        const a = rawA;
        const d = rawD;
        if (typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0 || a > VALID_BITS) {
          res.status(400).json({ error: `${target}[${i}].allow must be a valid non-negative integer` }); return;
        }
        if (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0 || d > VALID_BITS) {
          res.status(400).json({ error: `${target}[${i}].deny must be a valid non-negative integer` }); return;
        }
        if ((a & d) !== 0) {
          res.status(400).json({ error: `${target}[${i}]: allow and deny cannot contain overlapping bits` }); return;
        }
      }
      next(); return;
    }

    const pairs: BitmaskPair[] = Array.isArray(target)
      ? target
      : [{ allow: 'allow', deny: 'deny' }];

    for (const { allow: af = 'allow', deny: df = 'deny' } of pairs) {
      const rawA = body[af];
      const rawD = body[df];
      if (rawA === undefined && rawD === undefined) continue;
      const a = rawA ?? 0;
      const d = rawD ?? 0;
      if (typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0 || a > VALID_BITS) {
        res.status(400).json({ error: `${af} must be a valid non-negative integer` }); return;
      }
      if (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0 || d > VALID_BITS) {
        res.status(400).json({ error: `${df} must be a valid non-negative integer` }); return;
      }
      if ((a & d) !== 0) {
        res.status(400).json({ error: `${af} and ${df} cannot contain overlapping bits` }); return;
      }
    }
    next();
  };
}

// ── Socket event payload validation ──────────────────────────
// HTTP route'larında validateBody() kullanılır.
// Socket handler'ları içinse bu fonksiyon kullanılır: try/catch yoktur,
// geçersiz payload sessizce reddedilir (socket.emit yerine erken return).
//
// Kullanım (messages.ts içinde):
//   if (!validateSocketPayload(data, socketSchemas.sendMessage)) return;
//
export interface SocketValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSocketPayload(data: unknown, schema: Schema): SocketValidationResult {
  if (!data || typeof data !== 'object') return { valid: false, errors: ['payload must be an object'] };
  const errors: string[] = [];
  for (const [key, rules] of Object.entries(schema)) {
    validateField(key, (data as Record<string, unknown>)[key], rules, errors);
  }
  return { valid: errors.length === 0, errors };
}

// Socket handler payload schema'ları
export const socketSchemas = {
  sendMessage: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    serverId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    content:   { type: 'string' as const, max: 2000 },          // file mesajlarında opsiyonel
    type:      { type: 'string' as const, enum: ['normal', 'file', 'sticker'] },
    replyToId: { type: 'string' as const, max: 64 },
    fileUrl:   { type: 'string' as const, max: 512 },
    fileName:  { type: 'string' as const, max: 200 },
    fileType:  { type: 'string' as const, max: 64 },
    stickerPackId: { type: 'string' as const, max: 64 },
    stickerId:     { type: 'string' as const, max: 64 },
  } satisfies Schema,

  editMessage: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    content:   { type: 'string' as const, required: true, min: 1, max: 2000 },
    clientNonce: { type: 'string' as const, min: 1, max: 64 },
  } satisfies Schema,

  reactMessage: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    emoji:     { type: 'string' as const, required: true, min: 1, max: 10 },
    active:    { type: 'boolean' as const },
  } satisfies Schema,

  deleteMessage: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    clientNonce: { type: 'string' as const, min: 1, max: 64 },
  } satisfies Schema,

  pinMessage: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    serverId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    pinned:    { type: 'boolean' as const },
  } satisfies Schema,

  fileSend: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    serverId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    fileUrl:   { type: 'string' as const, required: true, min: 1, max: 512 },
    fileName:  { type: 'string' as const, required: true, min: 1, max: 200 },
    fileType:  { type: 'string' as const, max: 64 },
  } satisfies Schema,

  // ── DM / Group-DM schemas ────────────────────────────────────────────────

  /** dm:send */
  dmSend: {
    toUserId:    { type: 'string' as const, required: true, min: 1, max: 64 },
    content:     { type: 'string' as const, required: true, min: 1, max: 20_000 },
    clientNonce: { type: 'string' as const, min: 1, max: 64 },
  } satisfies Schema,

  /** dm:react */
  dmReact: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    dmId:      { type: 'string' as const, required: true, min: 1, max: 128 },
    emoji:     { type: 'string' as const, required: true, min: 1, max: 16 },
  } satisfies Schema,

  /** dm:call:start */
  dmCallStart: {
    toUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
    type:     { type: 'string' as const, enum: ['voice', 'video'] },
  } satisfies Schema,

  /** dm:call:accept / dm:call:decline / dm:call:end */
  dmCallId: {
    callId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** gdm:send */
  gdmSend: {
    groupId:     { type: 'string' as const, required: true, min: 1, max: 64 },
    content:     { type: 'string' as const, required: true, min: 1, max: 2000 },
    clientNonce: { type: 'string' as const, min: 1, max: 64 },
  } satisfies Schema,

  /** gdm:typing */
  gdmGroupId: {
    groupId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** gdm:call:start / gdm:call:join */
  gdmCallStart: {
    groupId: { type: 'string' as const, required: true, min: 1, max: 64 },
    type:    { type: 'string' as const, enum: ['voice', 'video'] },
  } satisfies Schema,

  /** gdm:call:state */
  gdmCallState: {
    groupId: { type: 'string' as const, required: true, min: 1, max: 64 },
    muted:   { type: 'boolean' as const },
    video:   { type: 'boolean' as const },
  } satisfies Schema,

  // ── Canvas schemas ───────────────────────────────────────────────────────

  /** canvas:join / canvas:leave / canvas:clear / canvas:state-request */
  canvasChannelId: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** canvas:draw */
  canvasDraw: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    stroke:    { type: 'object' as const, required: true },
  } satisfies Schema,

  /** canvas:stroke-delete */
  canvasStrokeDelete: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    strokeId:  { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Stage schemas ────────────────────────────────────────────────────────

  /** stage:join / stage:leave */
  stageChannelId: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** stage:setRole */
  stageSetRole: {
    channelId:   { type: 'string' as const, required: true, min: 1, max: 64 },
    role:        { type: 'string' as const, required: true, enum: ['speaker', 'listener'] },
    displayName: { type: 'string' as const, max: 80 },
    avatarColor: { type: 'string' as const, max: 20 },
  } satisfies Schema,

  /** stage:updateMute */
  stageUpdateMute: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    muted:     { type: 'boolean' as const, required: true },
  } satisfies Schema,

  /** stage:speaking */
  stageSpeaking: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    speaking:  { type: 'boolean' as const, required: true },
  } satisfies Schema,

  /** stage:handRaise */
  stageHandRaise: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    raised:    { type: 'boolean' as const, required: true },
  } satisfies Schema,

  /** stage:promote / stage:demote */
  stageTarget: {
    channelId:    { type: 'string' as const, required: true, min: 1, max: 64 },
    targetUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** stage:setTopic */
  stageSetTopic: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    topic:     { type: 'string' as const, max: 200 },
  } satisfies Schema,

  /** stage:setLive */
  stageSetLive: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    live:      { type: 'boolean' as const, required: true },
  } satisfies Schema,

  // ── WebRTC Signaling schemas ─────────────────────────────────────────────
  // Sprint 75: dm:call:offer / dm:call:answer / dm:call:ice validation eklendi.
  // webrtc-signaling-validation.test.ts'deki TODO'lar bu şemalarla kapandı.

  /** dm:call:offer / dm:call:answer / dm:call:ice — ortak zorunlu alanlar */
  dmCallSignal: {
    callId:       { type: 'string' as const, required: true, min: 1, max: 64 },
    targetUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** gdm:call:offer / gdm:call:answer / gdm:call:ice */
  gdmCallSignal: {
    groupId:        { type: 'string' as const, required: true, min: 1, max: 64 },
    targetSocketId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Voice schemas ────────────────────────────────────────────────────────

  /** voice:join / voice:leave */
  voiceJoin: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    serverId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    requestId: { type: 'string' as const, max: 96, pattern: /^[A-Za-z0-9:_-]+$/ },
  } satisfies Schema,

  /** voice:state-update */
  voiceStateUpdate: {
    channelId:     { type: 'string' as const, required: true, min: 1, max: 64 },
    muted:         { type: 'boolean' as const, required: true },
    deafened:      { type: 'boolean' as const, required: true },
    screensharing: { type: 'boolean' as const, required: true },
    video:         { type: 'boolean' as const, required: true },
  } satisfies Schema,

  /** voice:activity */
  voiceActivity: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    speaking:  { type: 'boolean' as const, required: true },
  } satisfies Schema,

  /** voice:e2e-key */
  voiceE2eKey: {
    channelId:    { type: 'string' as const, required: true, min: 1, max: 64 },
    targetUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
    encryptedKey: { type: 'string' as const, required: true, min: 1, max: 2048 },
  } satisfies Schema,

  /** webrtc:offer / webrtc:answer / webrtc:ice-candidate */
  webrtcSignal: {
    targetSocketId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Activity schemas ─────────────────────────────────────────────────────

  /** activity:start */
  activityStart: {
    activityId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    serverId:   { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** activity:join */
  activityJoin: {
    channelId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    sessionId:  { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** activity:leave / activity:list */
  activityChannelId: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Clip schemas ─────────────────────────────────────────────────────────

  /** clip:save */
  clipSave: {
    channelId:  { type: 'string' as const, required: true, min: 1, max: 64 },
    filename:   { type: 'string' as const, required: true, min: 1, max: 200 },
    mimeType:   { type: 'string' as const, max: 64 },
    sizeBytes:  { type: 'number' as const },
    durationMs: { type: 'number' as const },
  } satisfies Schema,

  /** clip:list */
  clipList: {
    channelId: { type: 'string' as const, max: 64 },
  } satisfies Schema,

  // ── Music schema ─────────────────────────────────────────────────────────

  /** music:ended */
  musicEnded: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Super-reaction schema ────────────────────────────────────────────────

  /** super_reaction:add */
  superReactionAdd: {
    messageId: { type: 'string' as const, required: true, min: 1, max: 64 },
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    emoji:     { type: 'string' as const, required: true, min: 1, max: 10 },
  } satisfies Schema,

  // ── Stage-video-grid schemas ─────────────────────────────────────────────

  /** stage:video-join / stage:video-leave */
  stageVideoChannelId: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** stage:video-layout */
  stageVideoLayout: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    layout:    { type: 'string' as const, required: true, enum: ['grid', 'spotlight'] },
  } satisfies Schema,

  /** sfu:produced */
  sfuProduced: {
    kind: { type: 'string' as const, required: true, enum: ['audio', 'video', 'screen'] },
  } satisfies Schema,

  // ── Infra schemas ────────────────────────────────────────────────────────

  /** typing:start / typing:stop */
  typingChannel: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** status:update */
  statusUpdate: {
    status:      { type: 'string' as const, required: true, enum: ['online', 'idle', 'dnd', 'offline'] },
    statusText:  { type: 'string' as const, max: 128 },
    statusEmoji: { type: 'string' as const, max: 10 },
  } satisfies Schema,

  /** notif:pref */
  notifPref: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    level:     { type: 'string' as const, required: true, enum: ['all', 'mentions', 'none'] },
  } satisfies Schema,

  /** friend:request:notify */
  friendRequestNotify: {
    toUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** server:joined / server:left */
  serverIdPayload: {
    serverId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** channel:created / channel:updated / channel:deleted */
  channelBroadcast: {
    serverId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** soundboard:play */
  soundboardPlay: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    soundId:   { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  // ── Channel E2EE schemas ─────────────────────────────────────────────────

  /** channel:e2ee:status / channel:e2ee:join */
  e2eeChannelId: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
  } satisfies Schema,

  /** channel:e2ee:keys:get */
  e2eeKeysGet: {
    channelId: { type: 'string' as const, required: true, min: 1, max: 64 },
    epoch:     { type: 'number' as const },
  } satisfies Schema,

  // ── DM-read schema ───────────────────────────────────────────────────────

  /** dm:read */
  dmRead: {
    dmId: { type: 'string' as const, required: true, min: 1, max: 128 },
  } satisfies Schema,
};


export interface SafeParseResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { issues?: Array<{ path?: Array<string | number>; message: string }> };
}

export interface ZSchema<T = unknown> {
  safeParse(value: unknown): SafeParseResult<T>;
  optional(): ZSchema<T | undefined>;
  min(_n: number): ZSchema<T>;
  max(_n: number): ZSchema<T>;
  datetime(): ZSchema<T>;
  refine(_fn: (value: T) => boolean, _opts?: { message?: string }): ZSchema<T>;
  partial(): ZSchema<Partial<T>>;
  extend<U extends Record<string, ZSchema>>(shape: U): ZSchema<T & { [K in keyof U]: unknown }>;
}

type SchemaParser<T> = (value: unknown) => SafeParseResult<T>;

function success<T>(data: T): SafeParseResult<T> { return { success: true, data }; }
function failure(message: string, path?: Array<string | number>): SafeParseResult<never> {
  return { success: false, error: { issues: [{ ...(path ? { path } : {}), message }] } };
}

class ChainSchema<T = unknown> implements ZSchema<T> {
  constructor(
    private readonly parser: SchemaParser<T> = (value) => success(value as T),
    private readonly objectShape?: Record<string, ZSchema>,
  ) {}

  safeParse(value: unknown): SafeParseResult<T> { return this.parser(value); }

  private constrained(predicate: (value: T) => boolean, message: string): ChainSchema<T> {
    return new ChainSchema<T>((value) => {
      const base = this.safeParse(value);
      if (!base.success) return base;
      try {
        return predicate(base.data as T) ? base : failure(message);
      } catch {
        return failure(message);
      }
    }, this.objectShape);
  }

  optional(): ZSchema<T | undefined> {
    return new ChainSchema<T | undefined>((value) => value === undefined ? success(undefined) : this.safeParse(value));
  }

  min(n: number): ZSchema<T> {
    return this.constrained((value) => {
      if (typeof value === 'string' || Array.isArray(value)) return value.length >= n;
      if (typeof value === 'number') return value >= n;
      return false;
    }, `Must be at least ${n}`);
  }

  max(n: number): ZSchema<T> {
    return this.constrained((value) => {
      if (typeof value === 'string' || Array.isArray(value)) return value.length <= n;
      if (typeof value === 'number') return value <= n;
      return false;
    }, `Must be at most ${n}`);
  }

  datetime(): ZSchema<T> {
    return this.constrained((value) => {
      if (typeof value !== 'string') return false;
      // Require an ISO-8601 date-time, not values Date.parse happens to coerce.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
      return Number.isFinite(Date.parse(value));
    }, 'Invalid datetime');
  }

  refine(fn: (value: T) => boolean, opts?: { message?: string }): ZSchema<T> {
    return this.constrained(fn, opts?.message || 'Invalid payload');
  }

  partial(): ZSchema<Partial<T>> {
    if (!this.objectShape) return this as unknown as ZSchema<Partial<T>>;
    const partialShape: Record<string, ZSchema> = {};
    for (const [key, schema] of Object.entries(this.objectShape)) partialShape[key] = schema.optional();
    return makeObjectSchema(partialShape) as unknown as ZSchema<Partial<T>>;
  }

  extend<U extends Record<string, ZSchema>>(shape: U): ZSchema<T & { [K in keyof U]: unknown }> {
    if (!this.objectShape) return this as unknown as ZSchema<T & { [K in keyof U]: unknown }>;
    return makeObjectSchema({ ...this.objectShape, ...shape }) as unknown as ZSchema<T & { [K in keyof U]: unknown }>;
  }
}

function makeObjectSchema<T extends Record<string, ZSchema>>(shape: T): ChainSchema<{ [K in keyof T]: ZInfer<T[K]> }> {
  return new ChainSchema<{ [K in keyof T]: ZInfer<T[K]> }>((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('Expected object');
    const input = value as Record<string, unknown>;
    for (const [key, schema] of Object.entries(shape)) {
      const parsed = schema.safeParse(input[key]);
      if (!parsed.success) {
        const issue = parsed.error?.issues?.[0];
        return failure(issue?.message || 'Invalid payload', [key, ...(issue?.path || [])]);
      }
    }
    return success(value as { [K in keyof T]: ZInfer<T[K]> });
  }, shape);
}

type ZInfer<T> = T extends ZSchema<infer U> ? U : unknown;

export const z = {
  string: () => new ChainSchema<string>((value) => typeof value === 'string' ? success(value) : failure('Expected string')),
  number: () => new ChainSchema<number>((value) => typeof value === 'number' && Number.isFinite(value) ? success(value) : failure('Expected number')),
  boolean: () => new ChainSchema<boolean>((value) => typeof value === 'boolean' ? success(value) : failure('Expected boolean')),
  array: <T = unknown>(schema?: ZSchema<T>) => new ChainSchema<T[]>((value) => {
    if (!Array.isArray(value)) return failure('Expected array');
    if (schema) {
      for (let i = 0; i < value.length; i++) {
        const parsed = schema.safeParse(value[i]);
        if (!parsed.success) {
          const issue = parsed.error?.issues?.[0];
          return failure(issue?.message || 'Invalid array item', [i, ...(issue?.path || [])]);
        }
      }
    }
    return success(value as T[]);
  }),
  object: <T extends Record<string, ZSchema>>(shape?: T) => shape
    ? makeObjectSchema(shape)
    : new ChainSchema<Record<string, unknown>>((value) => value && typeof value === 'object' && !Array.isArray(value)
      ? success(value as Record<string, unknown>) : failure('Expected object')) as unknown as ChainSchema<{ [K in keyof T]: ZInfer<T[K]> }>,
  enum: <T extends readonly string[]>(values: T) => new ChainSchema<T[number]>((value) =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? success(value as T[number]) : failure(`Expected one of: ${values.join(', ')}`)),
};

export namespace z {
  export type infer<T> = T extends ZSchema<infer U> ? U : unknown;
}

export function validate(schema: Schema | ZSchema) {
  if (schema && typeof (schema as ZSchema).safeParse === 'function') {
    return (req: Request, res: Response, next: NextFunction): void => {
      const parsed = (schema as ZSchema).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error?.issues?.[0]?.message || 'Invalid payload' });
        return;
      }
      req.body = parsed.data;
      next();
    };
  }
  return validateBody(schema as Schema);
}
