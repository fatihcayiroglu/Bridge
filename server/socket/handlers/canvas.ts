// server/socket/handlers/canvas.js
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

'use strict';

const { Channels, Members } = require('../../db/repositories');

// ── Konfigürasyon ─────────────────────────────────────────────
const MAX_STROKES             = parseInt(process.env.CANVAS_MAX_STROKES             ?? '2000', 10);
const TTL_SECONDS             = parseInt(process.env.CANVAS_TTL_SECONDS             ?? '86400', 10);
const MAX_CLIENTS_PER_CHANNEL = parseInt(process.env.MAX_CANVAS_CLIENTS_PER_CHANNEL ?? '20',    10);

// ── Redis anahtarları ─────────────────────────────────────────
const REDIS_STROKES_KEY = (channelId) => `bridge:canvas:${channelId}:strokes`;
const REDIS_META_KEY    = (channelId) => `bridge:canvas:${channelId}:meta`;

// ── Redis client (lazy init) ──────────────────────────────────
let _redisClient: any = null;
let _redisReady:boolean = false;

async function getRedis() {
  if (_redisClient && _redisReady) return _redisClient;
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    if (!_redisClient) {
      try {
        const adapter = require('../../lib/redisAdapter');
        if (adapter._pubClient && adapter._pubClient.isOpen) {
          _redisClient = adapter._pubClient;
          _redisReady  = true;
          return _redisClient;
        }
      } catch { /* adapter yoksa kendi client'ımızı oluştururuz */ }

      _redisClient = createClient({ url: REDIS_URL });
      _redisClient.on('error', (e) => console.error('[canvas redis error]', e));
      await _redisClient.connect();
    }
    _redisReady = _redisClient?.isOpen ?? false;
    return _redisReady ? _redisClient : null;
  } catch (err) {
    console.warn('[canvas] Redis bağlantısı kurulamadı, in-memory moda geçiliyor:', err.message);
    return null;
  }
}

// ── In-memory fallback ────────────────────────────────────────
const memCanvas = new Map();

function getMemCanvas(channelId) {
  if (!memCanvas.has(channelId)) {
    memCanvas.set(channelId, { strokes: [], clearedAt: null, createdAt: Date.now() });
  }
  return memCanvas.get(channelId);
}

const TTL_MS = TTL_SECONDS * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, c] of memCanvas) {
    if (c.createdAt < cutoff && !c.strokes.length) memCanvas.delete(id);
  }
}, 60 * 60 * 1000);

// ── Redis yardımcıları ────────────────────────────────────────
async function loadStrokes(channelId) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.lRange(REDIS_STROKES_KEY(channelId), 0, MAX_STROKES - 1);
      return raw
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .reverse();
    } catch (err) {
      console.error('[canvas] loadStrokes Redis hatası:', err.message);
    }
  }
  return getMemCanvas(channelId).strokes;
}

async function appendStroke(channelId, stroke) {
  const redis = await getRedis();
  if (redis) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      await redis.lPush(key, JSON.stringify(stroke));
      await redis.lTrim(key, 0, MAX_STROKES - 1);
      await redis.expire(key, TTL_SECONDS);
    } catch (err) {
      console.error('[canvas] appendStroke Redis hatası:', err.message);
    }
    return;
  }
  const state = getMemCanvas(channelId);
  if (state.strokes.length >= MAX_STROKES) state.strokes.shift();
  state.strokes.push(stroke);
}

async function removeStroke(channelId, strokeId, userId) {
  const redis = await getRedis();
  if (redis) {
    try {
      const key = REDIS_STROKES_KEY(channelId);
      const all = await redis.lRange(key, 0, -1);
      const target = all.find((s) => {
        try { const p = JSON.parse(s); return p.id === strokeId && p.userId === userId; }
        catch { return false; }
      });
      if (!target) return false;
      await redis.lRem(key, 1, target);
      return true;
    } catch (err) {
      console.error('[canvas] removeStroke Redis hatası:', err.message);
      return false;
    }
  }
  const state = getMemCanvas(channelId);
  const before = state.strokes.length;
  state.strokes = state.strokes.filter((s) => !(s.id === strokeId && s.userId === userId));
  return state.strokes.length !== before;
}

async function clearStrokes(channelId) {
  const redis = await getRedis();
  if (redis) {
    try { await redis.del(REDIS_STROKES_KEY(channelId)); }
    catch (err) { console.error('[canvas] clearStrokes Redis hatası:', err.message); }
    return;
  }
  getMemCanvas(channelId).strokes = [];
}

async function loadMeta(channelId) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(REDIS_META_KEY(channelId));
      if (raw) {
        const parsed = JSON.parse(raw);
        return { clearedAt: parsed.clearedAt ?? null, createdAt: parsed.createdAt ?? Date.now() };
      }
    } catch (err) { console.error('[canvas] loadMeta Redis hatası:', err.message); }
    return { clearedAt: null, createdAt: Date.now() };
  }
  const c = getMemCanvas(channelId);
  return { clearedAt: c.clearedAt, createdAt: c.createdAt };
}

async function saveMeta(channelId, meta) {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(REDIS_META_KEY(channelId), JSON.stringify(meta), { EX: TTL_SECONDS });
    } catch (err) { console.error('[canvas] saveMeta Redis hatası:', err.message); }
    return;
  }
  const c = getMemCanvas(channelId);
  c.clearedAt = meta.clearedAt;
  c.createdAt = meta.createdAt;
}

// ── Stroke doğrulama ──────────────────────────────────────────
const VALID_TOOLS = new Set(['pen', 'eraser', 'line', 'rect', 'circle', 'text']);
const COLOR_RE    = /^#[0-9a-fA-F]{3,8}$/;

function sanitizeStroke(raw, user) {
  const tool = VALID_TOOLS.has(raw.tool) ? raw.tool : 'pen';
  return {
    id:          String(raw.id ?? Date.now()),
    tool,
    color:       COLOR_RE.test(raw.color ?? '') ? raw.color : '#ffffff',
    width:       Math.min(Math.max(Number(raw.width) || 2, 1), 40),
    points:      (raw.points ?? []).slice(0, 512).map((p) => ({ x: +p.x || 0, y: +p.y || 0 })),
    text:        raw.tool === 'text' ? String(raw.text ?? '').slice(0, 200) : undefined,
    userId:      user._id,
    displayName: user.displayName,
    ts:          Date.now(),
  };
}

// ── Handler kaydı ─────────────────────────────────────────────
function registerCanvasHandlers(socket, io, user) {

  // ── canvas:join ──────────────────────────────────────────
  socket.on('canvas:join', async ({ channelId }) => {
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
      console.error('[canvas:join] üyelik kontrolü hatası:', err.message);
      socket.emit('error', { event: 'canvas:join', message: 'Yetkilendirme hatası.' });
      return;
    }

    // Oda başına 20 client limiti
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
      console.error('[canvas:join] state-sync hatası:', err.message);
      socket.emit('canvas:state-sync', { channelId, strokes: [], clearedAt: null });
    }
  });

  // ── canvas:leave ─────────────────────────────────────────
  socket.on('canvas:leave', ({ channelId }) => {
    socket.leave(`canvas:${channelId}`);
  });

  // ── canvas:draw ──────────────────────────────────────────
  socket.on('canvas:draw', async ({ channelId, stroke }) => {
    if (!stroke || typeof stroke !== 'object') return;
    const safe = sanitizeStroke(stroke, user);
    try { await appendStroke(channelId, safe); }
    catch (err) { console.error('[canvas:draw] kayıt hatası:', err.message); }
    socket.to(`canvas:${channelId}`).emit('canvas:draw', { channelId, stroke: safe });
  });

  // ── canvas:stroke-delete ─────────────────────────────────
  socket.on('canvas:stroke-delete', async ({ channelId, strokeId }) => {
    try {
      const deleted = await removeStroke(channelId, strokeId, user._id);
      if (deleted) io.to(`canvas:${channelId}`).emit('canvas:stroke-delete', { channelId, strokeId });
    } catch (err) { console.error('[canvas:stroke-delete] hata:', err.message); }
  });

  // ── canvas:clear ─────────────────────────────────────────
  socket.on('canvas:clear', async ({ channelId }) => {
    const clearedAt = Date.now();
    try {
      await Promise.all([
        clearStrokes(channelId),
        saveMeta(channelId, { clearedAt, createdAt: Date.now() }),
      ]);
    } catch (err) { console.error('[canvas:clear] hata:', err.message); }
    io.to(`canvas:${channelId}`).emit('canvas:clear', {
      channelId,
      clearedBy: { userId: user._id, displayName: user.displayName },
      clearedAt,
    });
  });

  // ── canvas:state-request ─────────────────────────────────
  socket.on('canvas:state-request', async ({ channelId }) => {
    try {
      const [strokes, meta] = await Promise.all([loadStrokes(channelId), loadMeta(channelId)]);
      socket.emit('canvas:state-sync', { channelId, strokes, clearedAt: meta.clearedAt });
    } catch (err) {
      console.error('[canvas:state-request] hata:', err.message);
      socket.emit('canvas:state-sync', { channelId, strokes: [], clearedAt: null });
    }
  });
}

module.exports = { registerCanvasHandlers, canvasState: memCanvas };
export {};
