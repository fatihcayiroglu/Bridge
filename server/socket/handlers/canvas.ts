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

import type { Server as IOServer, Socket } from 'socket.io';
import { Channels, Members } from '../../db/repositories';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { tryRequire } from '../../lib/_optional-require';
import logger from '../../lib/logger';

const MAX_STROKES             = parseInt(process.env.CANVAS_MAX_STROKES             ?? '2000', 10);
const TTL_SECONDS             = parseInt(process.env.CANVAS_TTL_SECONDS             ?? '86400', 10);
const MAX_CLIENTS_PER_CHANNEL = parseInt(process.env.MAX_CANVAS_CLIENTS_PER_CHANNEL ?? '20',    10);

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

// ── Redis client (lazy init) ──────────────────────────────────

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  /** set(key, value) — TTL'siz basit set */
  set(key: string, value: string): Promise<unknown>;
  /** setEx(key, ttlSeconds, value) — TTL ile set (saveMeta'da kullanılır) */
  setEx(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  /** Redis List — başa eleman ekle (LPUSH) */
  lPush(key: string, ...elements: string[]): Promise<number>;
  /** Redis List — listeyi [start, stop] aralığına kırp (LTRIM) */
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  /** Redis List — [start, stop] aralığındaki elemanları getir (LRANGE) */
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  /** Redis List — belirli değeri sil (LREM) */
  lRem(key: string, count: number, element: string): Promise<number>;
  /** Anahtarın TTL'ini güncelle (EXPIRE) */
  expire(key: string, ttl: number): Promise<unknown>;
  /** Bağlantı durumu */
  isOpen: boolean;
  /** Olay dinleyicisi */
  on(event: string, cb: (err?: Error) => void): void;
  /** Bağlan */
  connect(): Promise<void>;
}

let _redisClient: RedisClientLike | null = null;
let _redisReady = false;

async function getRedis(): Promise<RedisClientLike | null> {
  if (_redisClient && _redisReady) return _redisClient;
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) return null;
  try {
    const redisLib = tryRequire<{ createClient(opts: { url: string }): RedisClientLike }>('redis');
    if (!redisLib) return null;
    const { createClient } = redisLib;
    if (!_redisClient) {
      try {
        const adapter = tryRequire<{ _pubClient?: RedisClientLike }>('../../lib/redisAdapter');
        if (adapter?._pubClient?.isOpen) {
          _redisClient = adapter._pubClient;
          _redisReady  = true;
          return _redisClient;
        }
      } catch { /* adapter yoksa kendi client'ımızı oluştururuz */ }

      _redisClient = createClient({ url: REDIS_URL });
      _redisClient.on('error', (e?: Error) =>
        logger.error({ err: e?.message, event: 'canvas.redis.error' }, '[canvas] Redis hatası'),
      );
      await _redisClient.connect();
    }
    _redisReady = _redisClient?.isOpen ?? false;
    return _redisReady ? _redisClient : null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, event: 'canvas.redis.connect_failed' },
      '[canvas] Redis bağlantısı kurulamadı, in-memory moda geçiliyor',
    );
    return null;
  }
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
}, 60 * 60 * 1000);

// ── Redis yardımcıları ────────────────────────────────────────
async function loadStrokes(channelId: string): Promise<CanvasStroke[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.lRange(REDIS_STROKES_KEY(channelId), 0, MAX_STROKES - 1);
      return raw
        .map((s) => { try { return JSON.parse(s) as CanvasStroke; } catch { return null; } })
        .filter((x): x is CanvasStroke => x !== null)
        .reverse();
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.loadStrokes.error' },
        '[canvas] loadStrokes Redis hatası');
    }
  }
  return getMemCanvas(channelId).strokes;
}

async function appendStroke(channelId: string, stroke: CanvasStroke): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      await redis.lPush(key, JSON.stringify(stroke));
      await redis.lTrim(key, 0, MAX_STROKES - 1);
      await redis.expire(key, TTL_SECONDS);
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.appendStroke.error' },
        '[canvas] appendStroke Redis hatası');
    }
    return;
  }
  const state = getMemCanvas(channelId);
  if (state.strokes.length >= MAX_STROKES) state.strokes.shift();
  state.strokes.push(stroke);
}

async function removeStroke(channelId: string, strokeId: string, userId: string): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      const all = await redis.lRange(key, 0, -1);
      const target = all.find((s) => {
        try { const p = JSON.parse(s) as CanvasStroke; return p.id === strokeId && p.userId === userId; }
        catch { return false; }
      });
      if (!target) return false;
      await redis.lRem(key, 1, target);
      return true;
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.removeStroke.error' },
        '[canvas] removeStroke Redis hatası');
      return false;
    }
  }
  const state = getMemCanvas(channelId);
  const before = state.strokes.length;
  state.strokes = state.strokes.filter((s) => !(s.id === strokeId && s.userId === userId));
  return state.strokes.length !== before;
}

async function clearStrokes(channelId: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try { await redis.del(REDIS_STROKES_KEY(channelId)); }
    catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.clearStrokes.error' },
        '[canvas] clearStrokes Redis hatası');
    }
    return;
  }
  getMemCanvas(channelId).strokes = [];
}

async function loadMeta(channelId: string): Promise<CanvasMeta> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(REDIS_META_KEY(channelId));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CanvasMeta>;
        return { clearedAt: parsed.clearedAt ?? null, createdAt: parsed.createdAt ?? Date.now() };
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.loadMeta.error' },
        '[canvas] loadMeta Redis hatası');
    }
    return { clearedAt: null, createdAt: Date.now() };
  }
  const c = getMemCanvas(channelId);
  return { clearedAt: c.clearedAt, createdAt: c.createdAt };
}

async function saveMeta(channelId: string, meta: CanvasMeta): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      // setEx kullanılıyor — set(key, val, { EX }) imzası interface ile uyumsuzdu
      await redis.setEx(REDIS_META_KEY(channelId), TTL_SECONDS, JSON.stringify(meta));
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.saveMeta.error' },
        '[canvas] saveMeta Redis hatası');
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
  return {
    id:          String(raw.id ?? Date.now()),
    tool,
    color:       COLOR_RE.test(String(raw.color ?? '')) ? String(raw.color) : '#ffffff',
    width:       Math.min(Math.max(Number(raw.width) || 2, 1), 40),
    points:      (Array.isArray(raw.points) ? raw.points : [])
                   .slice(0, 512)
                   .map((p: unknown) => {
                     const pt = p as Record<string, unknown>;
                     return { x: +((pt?.x as number) || 0), y: +((pt?.y as number) || 0) };
                   }),
    text:        tool === 'text' ? String(raw.text ?? '').slice(0, 200) : undefined,
    userId:      user._id,
    displayName: user.displayName,
    ts:          Date.now(),
  };
}

// ── Handler kaydı ─────────────────────────────────────────────
function registerCanvasHandlers(
  socket: Socket & { user?: CanvasUser },
  io: IOServer,
  user: CanvasUser,
): void {

  // ── canvas:join ──────────────────────────────────────────
  socket.on('canvas:join', async (payload: unknown) => {
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
      if (!membership) {
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

    socket.join(room);

    try {
      const [strokes, meta] = await Promise.all([loadStrokes(channelId), loadMeta(channelId)]);
      socket.emit('canvas:state-sync', { channelId, strokes, clearedAt: meta.clearedAt });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.join.sync_error' },
        '[canvas:join] state-sync hatası');
      socket.emit('canvas:state-sync', { channelId, strokes: [], clearedAt: null });
    }
  });

  // ── canvas:leave ─────────────────────────────────────────
  socket.on('canvas:leave', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    socket.leave(`canvas:${channelId}`);
  });

  // ── canvas:draw ──────────────────────────────────────────
  socket.on('canvas:draw', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasDraw).valid) return;
    const { channelId, stroke } = payload as { channelId: string; stroke: unknown };
    if (!stroke || typeof stroke !== 'object') return;
    const safe = sanitizeStroke(stroke as Record<string, unknown>, user);
    try { await appendStroke(channelId, safe); }
    catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.draw.error' },
        '[canvas:draw] kayıt hatası');
    }
    socket.to(`canvas:${channelId}`).emit('canvas:draw', { channelId, stroke: safe });
  });

  // ── canvas:stroke-delete ─────────────────────────────────
  socket.on('canvas:stroke-delete', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasStrokeDelete).valid) return;
    const { channelId, strokeId } = payload as { channelId: string; strokeId: string };
    try {
      const deleted = await removeStroke(channelId, strokeId, user._id);
      if (deleted) io.to(`canvas:${channelId}`).emit('canvas:stroke-delete', { channelId, strokeId });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.stroke_delete.error' },
        '[canvas:stroke-delete] hata');
    }
  });

  // ── canvas:clear ─────────────────────────────────────────
  socket.on('canvas:clear', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    const clearedAt = Date.now();
    try {
      await Promise.all([
        clearStrokes(channelId),
        saveMeta(channelId, { clearedAt, createdAt: Date.now() }),
      ]);
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.clear.error' },
        '[canvas:clear] hata');
    }
    io.to(`canvas:${channelId}`).emit('canvas:clear', {
      channelId,
      clearedBy: { userId: user._id, displayName: user.displayName },
      clearedAt,
    });
  });

  // ── canvas:state-request ─────────────────────────────────
  socket.on('canvas:state-request', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.canvasChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    try {
      const [strokes, meta] = await Promise.all([loadStrokes(channelId), loadMeta(channelId)]);
      socket.emit('canvas:state-sync', { channelId, strokes, clearedAt: meta.clearedAt });
    } catch (err) {
      logger.error({ err: (err as Error).message, channelId, event: 'canvas.state_request.error' },
        '[canvas:state-request] hata');
      socket.emit('canvas:state-sync', { channelId, strokes: [], clearedAt: null });
    }
  });
}

export { registerCanvasHandlers };
export { memCanvas as canvasState };
