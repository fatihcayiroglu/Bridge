// server/socket/handlers/canvas.ts
// Ortak Çizim Tahtası — Socket.IO realtime canvas (Session 9)
//
// Depolama: Redis (@redis/client) ile native LPUSH/LTRIM/EXPIRE komutları.
//   bridge:canvas:<channelId>:strokes  → Redis List (JSON strokeleri)
//   bridge:canvas:<channelId>:meta     → Redis key (JSON meta)
//
// Redis yoksa in-memory Map ile graceful degrade (geliştirme ortamı).
//
// Konfigürasyon (env):
//   CANVAS_MAX_STROKES              Kanal başına maksimum stroke (varsayılan: 2000)
//   CANVAS_TTL_SECONDS              Redis TTL saniye (varsayılan: 86400 = 24 saat)
//   MAX_CANVAS_CLIENTS_PER_CHANNEL  Kanal başına maksimum eşzamanlı bağlantı (varsayılan: 20)

import type { HandlerSocket, RoomScopedServer } from '../handler-contracts';
import { Channels, Members } from '../../db/repositories';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { PERMS, hasPermission, resolvePermissions } from '../../lib/permissions';
import logger from '../../lib/logger';
import { isolateSocketHandler } from '../handlerIsolation';
import { envSafeInt } from '../../lib/envNumbers';
import { cache, redisAuthoritativeCommand } from '../../lib/redisAdapter';


const MAX_STROKES = envSafeInt('CANVAS_MAX_STROKES', 2_000, { min: 1, max: 100_000 });
const TTL_SECONDS = envSafeInt('CANVAS_TTL_SECONDS', 86_400, { min: 60, max: 30 * 24 * 60 * 60 });
const MAX_CLIENTS_PER_CHANNEL = envSafeInt('MAX_CANVAS_CLIENTS_PER_CHANNEL', 20, { min: 1, max: 10_000 });

// ── Tip tanımları ─────────────────────────────────────────────

interface CanvasUser {
  _id: string;
  displayName?: string;
}

interface StrokePoint {
  x: number;
  y: number;
}

interface CanvasStroke {
  id:          string;
  tool:        string;
  color:       string;
  width:       number;
  points:      StrokePoint[];
  text?:       string;
  userId:      string;
  displayName?: string;
  ts:          number;
}

interface CanvasMeta {
  clearedAt: number | null;
  createdAt: number;
}

interface MemCanvasEntry {
  strokes:   CanvasStroke[];
  clearedAt: number | null;
  createdAt: number;
}

// ── Redis anahtarları ─────────────────────────────────────────
const REDIS_STROKES_KEY = (channelId: string): string => `bridge:canvas:${channelId}:strokes`;
const REDIS_META_KEY    = (channelId: string): string => `bridge:canvas:${channelId}:meta`;

// ── Redis client ───────────────────────────────────────────────
// Reuse the canonical application singleton. Opening a second private client
// here made readiness/cluster state disagree with canvas state and silently
// fell back to a per-process board when the shared authority was unavailable.
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  setEx(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, element: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

async function runCanvasRedis<T>(
  operation: string,
  command: (redis: RedisClientLike) => Promise<T>,
): Promise<T> {
  return redisAuthoritativeCommand(`canvas ${operation}`, raw => command(raw as RedisClientLike));
}

async function withCanvasMutationLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  return cache.withKeyLock(`canvas:${channelId}`, fn, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
}

// ── In-memory fallback ────────────────────────────────────────
const memCanvas = new Map<string, MemCanvasEntry>();

function getMemCanvas(channelId: string): MemCanvasEntry {
  if (!memCanvas.has(channelId)) {
    memCanvas.set(channelId, { strokes: [], clearedAt: null, createdAt: Date.now() });
  }
  return memCanvas.get(channelId)!;
}

const TTL_MS = TTL_SECONDS * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, c] of memCanvas) {
    if (c.createdAt < cutoff && !c.strokes.length) memCanvas.delete(id);
  }
}, 60 * 60 * 1000).unref?.();

// ── Redis yardımcıları ────────────────────────────────────────
async function loadStrokes(channelId: string): Promise<CanvasStroke[]> {
  if (REDIS_CONFIGURED) {
    try {
      const raw = await runCanvasRedis('load strokes', redis =>
        redis.lRange(REDIS_STROKES_KEY(channelId), 0, MAX_STROKES - 1));
      return raw
        .map((s) => { try { return JSON.parse(s) as CanvasStroke; } catch { return null; } })
        .filter((x): x is CanvasStroke => x !== null)
        .reverse();
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.loadStrokes.error' },
        '[canvas] loadStrokes Redis hatası');
      throw err;
    }
  }
  return getMemCanvas(channelId).strokes;
}

async function appendStroke(channelId: string, stroke: CanvasStroke): Promise<void> {
  if (REDIS_CONFIGURED) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      await runCanvasRedis('append stroke', redis => redis.eval(`
        redis.call('LPUSH', KEYS[1], ARGV[1])
        redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]))
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
        return 1
      `, {
        keys: [key],
        arguments: [JSON.stringify(stroke), String(MAX_STROKES - 1), String(TTL_SECONDS)],
      }));
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.appendStroke.error' },
        '[canvas] appendStroke Redis hatası');
      throw err;
    }
    return;
  }
  const state = getMemCanvas(channelId);
  if (state.strokes.length >= MAX_STROKES) state.strokes.shift();
  state.strokes.push(stroke);
}

async function removeStroke(channelId: string, strokeId: string, userId: string): Promise<boolean> {
  if (REDIS_CONFIGURED) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      const all = await runCanvasRedis('load strokes for removal', redis => redis.lRange(key, 0, -1));
      const target = all.find((s) => {
        try { const p = JSON.parse(s) as CanvasStroke; return p.id === strokeId && p.userId === userId; }
        catch { return false; }
      });
      if (!target) return false;
      await runCanvasRedis('remove stroke', redis => redis.lRem(key, 1, target));
      return true;
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.removeStroke.error' },
        '[canvas] removeStroke Redis hatası');
      throw err;
    }
  }
  const state = getMemCanvas(channelId);
  const before = state.strokes.length;
  state.strokes = state.strokes.filter((s) => !(s.id === strokeId && s.userId === userId));
  return state.strokes.length !== before;
}

async function clearStrokes(channelId: string): Promise<void> {
  if (REDIS_CONFIGURED) {
    try { await runCanvasRedis('clear strokes', redis => redis.del(REDIS_STROKES_KEY(channelId))); }
    catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.clearStrokes.error' },
        '[canvas] clearStrokes Redis hatası');
      throw err;
    }
    return;
  }
  getMemCanvas(channelId).strokes = [];
}

async function loadMeta(channelId: string): Promise<CanvasMeta> {
  if (REDIS_CONFIGURED) {
    try {
      const raw = await runCanvasRedis('load metadata', redis => redis.get(REDIS_META_KEY(channelId)));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CanvasMeta>;
        return { clearedAt: parsed.clearedAt ?? null, createdAt: parsed.createdAt ?? Date.now() };
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.loadMeta.error' },
        '[canvas] loadMeta Redis hatası');
      throw err;
    }
    return { clearedAt: null, createdAt: Date.now() };
  }
  const c = getMemCanvas(channelId);
  return { clearedAt: c.clearedAt, createdAt: c.createdAt };
}

async function saveMeta(channelId: string, meta: CanvasMeta): Promise<void> {
  if (REDIS_CONFIGURED) {
    try {
      await runCanvasRedis('save metadata', redis =>
        redis.setEx(REDIS_META_KEY(channelId), TTL_SECONDS, JSON.stringify(meta)));
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.saveMeta.error' },
        '[canvas] saveMeta Redis hatası');
      throw err;
    }
    return;
  }
  const c = getMemCanvas(channelId);
  c.clearedAt = meta.clearedAt;
  c.createdAt = meta.createdAt;
}

// ── Stroke doğrulama ──────────────────────────────────────────
const VALID_TOOLS = new Set(['pen', 'eraser', 'line', 'rect', 'circle', 'text']);
const COLOR_RE    = /^#[0-9a-fA-F]{3,8}$/;

function sanitizeStroke(raw: Record<string, unknown>, user: CanvasUser): CanvasStroke {
  const tool = VALID_TOOLS.has(String(raw.tool)) ? String(raw.tool) : 'pen';
  const numericWidth = typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : 2;
  const coord = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(-1_000_000, Math.min(1_000_000, value));
  };
  const rawId = typeof raw.id === 'string' && raw.id ? raw.id : String(Date.now());
  return {
    id:          rawId.slice(0, 64),
    tool,
    color:       COLOR_RE.test(String(raw.color ?? '')) ? String(raw.color) : '#ffffff',
    width:       Math.min(Math.max(numericWidth, 1), 40),
    points:      (Array.isArray(raw.points) ? raw.points : [])
                   .slice(0, 512)
                   .map((p: unknown) => {
                     const pt = p && typeof p === 'object' ? p as Record<string, unknown> : {};
                     return { x: coord(pt.x), y: coord(pt.y) };
                   }),
    text:        tool === 'text' ? String(raw.text ?? '').slice(0, 200) : undefined,
    userId:      user._id,
    displayName: user.displayName,
    ts:          Date.now(),
  };
}

// ── Handler kaydı ─────────────────────────────────────────────
function registerCanvasHandlers(
  socket: HandlerSocket & { user?: CanvasUser },
  io: RoomScopedServer,
  user: CanvasUser,
): void {
  // Authorization is bound to this socket, not to a client-supplied channelId.
  // A socket must complete canvas:join before it can mutate that room.
  const joinedCanvasRooms = new Set<string>();

  const hasCanvasAccess = async (channelId: string): Promise<boolean> => {
    if (!joinedCanvasRooms.has(channelId)) return false;
    try {
      const channel = await Channels.findById(channelId);
      if (!channel?.serverId) return false;
      const membership = await Members.findOne(user._id, channel.serverId);
      if (!membership) return false;
      const perms = await resolvePermissions(user._id, channel.serverId, channelId);
      return hasPermission(perms, PERMS.VIEW_CHANNELS);
    } catch {
      return false;
    }
  };

  // ── canvas:join ──────────────────────────────────────────
  socket.on('canvas:join', isolateSocketHandler(socket, 'canvas:join', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    const room = `canvas:${channelId}`;

    // Güvenlik: kullanıcının bu kanala üye olup olmadığını doğrula
    try {
      const channel = await Channels.findById(channelId);
      if (!channel) {
        socket.emit('error', { event: 'canvas:join', message: 'Kanal bulunamadı.' });
        return;
      }
      const membership = await Members.findOne(user._id, channel.serverId);
      const perms = membership ? await resolvePermissions(user._id, channel.serverId, channelId) : 0;
      if (!membership || !hasPermission(perms, PERMS.VIEW_CHANNELS)) {
        socket.emit('error', { event: 'canvas:join', message: 'Bu kanala erişim yetkiniz yok.' });
        return;
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.join.auth_error' },
        '[canvas:join] üyelik kontrolü hatası');
      socket.emit('error', { event: 'canvas:join', message: 'Yetkilendirme hatası.' });
      return;
    }

    // Oda başına client limiti
    const roomSockets = await io.in(room).fetchSockets();
    if (roomSockets.length >= MAX_CLIENTS_PER_CHANNEL) {
      socket.emit('error:ratelimit', {
        event:   'canvas:join',
        message: `CANVAS_ROOM_FULL: Kanal başına maksimum ${MAX_CLIENTS_PER_CHANNEL} canvas bağlantısı.`,
      });
      return;
    }

    let state: { strokes: CanvasStroke[]; meta: CanvasMeta };
    try {
      const [strokes, meta] = await Promise.all([loadStrokes(channelId), loadMeta(channelId)]);
      state = { strokes, meta };
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.join.sync_error' },
        '[canvas:join] state-sync hatası');
      socket.emit('error', { event: 'canvas:join', message: 'Canvas durumu geçici olarak kullanılamıyor.' });
      return;
    }
    socket.join(room);
    joinedCanvasRooms.add(channelId);
    socket.emit('canvas:state-sync', { channelId, strokes: state.strokes, clearedAt: state.meta.clearedAt });
  }));

  // ── canvas:leave ─────────────────────────────────────────
  socket.on('canvas:leave', isolateSocketHandler(socket, 'canvas:leave', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    joinedCanvasRooms.delete(channelId);
    socket.leave(`canvas:${channelId}`);
  }));

  // ── canvas:draw ──────────────────────────────────────────
  socket.on('canvas:draw', isolateSocketHandler(socket, 'canvas:draw', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasDraw).valid) return;
    const { channelId, stroke } = payload as { channelId: string; stroke: unknown };
    if (!(await hasCanvasAccess(channelId))) return;
    if (!stroke || typeof stroke !== 'object') return;
    const safe = sanitizeStroke(stroke as Record<string, unknown>, user);
    try { await withCanvasMutationLock(channelId, () => appendStroke(channelId, safe)); }
    catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.draw.error' },
        '[canvas:draw] kayıt hatası');
      socket.emit('error', { event: 'canvas:draw', message: 'Canvas değişikliği kaydedilemedi.' });
      return;
    }
    socket.to(`canvas:${channelId}`).emit('canvas:draw', { channelId, stroke: safe });
  }));

  // ── canvas:stroke-delete ─────────────────────────────────
  socket.on('canvas:stroke-delete', isolateSocketHandler(socket, 'canvas:stroke-delete', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasStrokeDelete).valid) return;
    const { channelId, strokeId } = payload as { channelId: string; strokeId: string };
    if (!(await hasCanvasAccess(channelId))) return;
    try {
      const deleted = await withCanvasMutationLock(channelId, () => removeStroke(channelId, strokeId, user._id));
      if (deleted) io.to(`canvas:${channelId}`).emit('canvas:stroke-delete', { channelId, strokeId });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.stroke_delete.error' },
        '[canvas:stroke-delete] hata');
    }
  }));

  // ── canvas:clear ─────────────────────────────────────────
  socket.on('canvas:clear', isolateSocketHandler(socket, 'canvas:clear', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    if (!(await hasCanvasAccess(channelId))) return;
    const clearedAt = Date.now();
    try {
      await withCanvasMutationLock(channelId, async () => {
        await clearStrokes(channelId);
        await saveMeta(channelId, { clearedAt, createdAt: Date.now() });
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.clear.error' },
        '[canvas:clear] hata');
      socket.emit('error', { event: 'canvas:clear', message: 'Canvas temizlenemedi.' });
      return;
    }
    io.to(`canvas:${channelId}`).emit('canvas:clear', {
      channelId,
      clearedBy: { userId: user._id, displayName: user.displayName },
      clearedAt,
    });
  }));

  // ── canvas:state-request ─────────────────────────────────
  socket.on('canvas:state-request', isolateSocketHandler(socket, 'canvas:state-request', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    if (!(await hasCanvasAccess(channelId))) return;
    try {
      const [strokes, meta] = await Promise.all([loadStrokes(channelId), loadMeta(channelId)]);
      socket.emit('canvas:state-sync', { channelId, strokes, clearedAt: meta.clearedAt });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.state_request.error' },
        '[canvas:state-request] hata');
      socket.emit('error', { event: 'canvas:state-request', message: 'Canvas durumu geçici olarak kullanılamıyor.' });
    }
  }));

  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', () => {
    joinedCanvasRooms.clear();
  }));
}

export { registerCanvasHandlers };
export { memCanvas as canvasState };
