// server/socket/handlers/activities/draw-together.ts — Sprint 83
// Draw Together aktivitesi: gerçek zamanlı çizim canvas'ı + WebSocket sync
//
// Mevcut canvas.ts handler'ından farklıdır:
//   canvas.ts  → kalıcı whiteboard (Redis + HTTP route, channel bazlı)
//   draw-together → aktivite session bazlı, geçici, yüksek frekans broadcast
//
// Olaylar:
//   C→S  draw:stroke        Yeni fırça darbesi (mouse/touch sürükle)
//   C→S  draw:stroke-end    Stroke tamamlandı (mouse/touch bıraktı)
//   C→S  draw:undo          Son stroke'u geri al (sadece kendi)
//   C→S  draw:clear         Tüm canvas'ı temizle (host yetkisi)
//   C→S  draw:tool          Aktif araç/renk/boyut değişimi (broadcast için)
//   S→C  draw:stroke        Başkasından gelen stroke verisi
//   S→C  draw:stroke-end    Başkasından gelen stroke-end
//   S→C  draw:undo          Başkasının undo'su (strokeId belirtir)
//   S→C  draw:clear         Canvas temizlendi
//   S→C  draw:state         Mevcut session snapshot'ı (yeni katılana gönderilir)
//   S→C  draw:cursor        Başkasının cursor pozisyonu (throttle: 50ms)
//   C→S  draw:cursor        Cursor pozisyonu
//
// Stroke depolama: session sonunda silinir; ephemeral buffer (MAX_STROKES).
// Session state is Redis-authoritative in clustered deployments; cursor events remain ephemeral broadcasts.

import type { HandlerSocket, HandlerServer } from '../../handler-contracts';
import logger from '../../../lib/logger';
import { canViewChannel } from '../../../lib/permissions';
import { Channels } from '../../../db/repositories';
import { isolateSocketHandler } from '../../handlerIsolation';
import { drawStore, drawSessions } from './draw-store';


// ── Sabitler ──────────────────────────────────────────────────────────────────
const MAX_STROKES_PER_SESSION = 1000;  // bellek sınırı
const MAX_POINTS_PER_STROKE   = 500;   // tek stroke max koordinat sayısı
const CURSOR_THROTTLE_MS      = 50;    // cursor event min aralığı (ms)
const VALID_TOOLS             = new Set(['pen', 'eraser', 'line', 'rect', 'circle', 'fill', 'text']);
const MAX_COLOR_LEN           = 9;     // #rrggbbaa
const MAX_TEXT_LEN            = 200;
const MAX_STROKE_ID_LEN       = 128;
const MAX_COORDINATE_ABS      = 1_000_000;

// ── Tipler ────────────────────────────────────────────────────────────────────

export interface DrawPoint { x: number; y: number; }

export interface DrawStroke {
  id:          string;
  tool:        string;
  color:       string;
  size:        number;
  opacity:     number;
  points:      DrawPoint[];
  text?:       string;
  userId:      string;
  displayName: string;
  ts:          number;
  complete:    boolean;   // stroke-end alındıktan sonra true
}

export interface DrawSession {
  sessionId:    string;
  channelId:    string;
  strokes:      DrawStroke[];           // tamamlanmış stroklar
  activeStrokes: Map<string, DrawStroke>; // socketId → devam eden stroke
  participants: Map<string, { userId: string; displayName: string; color: string }>;
  createdAt:    number;
  hostSocketId: string;
}

interface ToolState {
  tool:    string;
  color:   string;
  size:    number;
  opacity?: number;
}

// ── Session store ─────────────────────────────────────────────────────────────
// Canonical state lives in draw-store (Redis when configured; local only in explicit single-node mode).

// Cursor throttle per socket
const cursorLastSent = new Map<string, number>();

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function serializeSession(s: DrawSession) {
  return {
    sessionId:   s.sessionId,
    channelId:   s.channelId,
    strokes:     s.strokes,
    participants: [...s.participants.values()],
    createdAt:   s.createdAt,
  };
}

function validatePoint(p: unknown): p is DrawPoint {
  if (!p || typeof p !== 'object') return false;
  const point = p as Partial<DrawPoint>;
  return typeof point.x === 'number'
    && typeof point.y === 'number'
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Math.abs(point.x) <= MAX_COORDINATE_ABS
    && Math.abs(point.y) <= MAX_COORDINATE_ABS;
}

function validatePoints(points: unknown, requireNonEmpty = true): string | null {
  if (!Array.isArray(points) || (requireNonEmpty && points.length === 0)) return 'points gerekli';
  if (points.length > MAX_POINTS_PER_STROKE) return 'Çok fazla nokta';
  if (points.some(p => !validatePoint(p))) return 'Geçersiz nokta formatı';
  return null;
}

function validateStroke(data: Partial<DrawStroke>): string | null {
  if (!data.id || typeof data.id !== 'string' || data.id.length > MAX_STROKE_ID_LEN) return 'Geçersiz stroke.id';
  if (!data.tool || !VALID_TOOLS.has(data.tool)) return `Geçersiz tool: ${data.tool}`;
  if (!data.color || typeof data.color !== 'string') return 'color gerekli';
  if (data.color.length > MAX_COLOR_LEN || !/^#[0-9a-fA-F]{3,8}$/.test(data.color))
    return 'Geçersiz color formatı';
  if (typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size < 1 || data.size > 100) return 'size: 1–100';
  if (typeof data.opacity !== 'number' || !Number.isFinite(data.opacity) || data.opacity < 0 || data.opacity > 1) return 'opacity: 0–1';
  const pointError = validatePoints(data.points);
  if (pointError) return pointError;
  if (data.text !== undefined && typeof data.text !== 'string') return 'Geçersiz metin';
  if (data.tool === 'text' && data.text && data.text.length > MAX_TEXT_LEN) return 'Metin çok uzun';
  return null;
}

function validateToolState(data: Partial<ToolState>): string | null {
  if (!data.tool || !VALID_TOOLS.has(data.tool)) return `Geçersiz tool: ${data.tool}`;
  if (!data.color || typeof data.color !== 'string'
      || data.color.length > MAX_COLOR_LEN || !/^#[0-9a-fA-F]{3,8}$/.test(data.color)) {
    return 'Geçersiz color formatı';
  }
  if (typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size < 1 || data.size > 100) return 'size: 1–100';
  if (data.opacity !== undefined
      && (typeof data.opacity !== 'number' || !Number.isFinite(data.opacity) || data.opacity < 0 || data.opacity > 1)) {
    return 'opacity: 0–1';
  }
  return null;
}

// ── KANAL ERISIM DENETIMI ────────────────────────────────────────────────────
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK ACIK (CANLI SUNUCUDA SOMURULDU)
// ════════════════════════════════════════════════════════════════════════════
// `draw:join` istemcinin gonderdigi `channelId` degerine KOSULSUZ guveniyordu:
// kanal uyeligi de sunucu uyeligi de denetlenmiyordu. Oturum yoksa SALDIRGAN
// ADINA olusturuluyor ve saldirgan `draw:<channelId>` odasina giriyordu.
//
// SOMURU (e2e/_draw-tenancy.cjs) — uyesi OLMAYAN bir kullanici:
//   OKUMA : kurban kanalindaki cizimleri aldi (metin araci icerigi dahil)
//   YAZMA : kurbanin tuvaline kendi cizimini enjekte etti
//
// Bu, daha once uc kez gorulen KARDES-YOL asimetrisinin ayni sinifidir:
// `messages-edit.ts` ve `members.ts` ayni kanal erisimi icin zaten
// `canViewChannel` kullaniyordu; aktivite yollari atlanmisti.
//
// ── TASARIM ─────────────────────────────────────────────────────────────────
// KATILMA aninda tam yetki denetimi yapilir (veritabani okumasi). Sonraki
// yuksek frekansli olaylar (stroke/cursor) her karede veritabanina gitmez;
// bunun yerine soketin GERCEKTEN o odada olup olmadigina bakilir. Oda uyeligi
// sunucu tarafi durumdur ve istemci tarafindan uydurulamaz.
async function mayJoinCanvas(socket: HandlerSocket, userId: string, channelId: string): Promise<boolean> {
  if (!channelId || typeof channelId !== 'string' || channelId.length > MAX_STROKE_ID_LEN) return false;
  if (!socket.rooms.has(`voice:${channelId}`)) return false;
  const channel = await Channels.findById(channelId).catch(() => null);
  if (!channel) return false;
  // Sunucu kimligi KANALDAN okunur — istemcinin iddiasindan degil.
  return canViewChannel(userId, String(channel.serverId), channelId).catch(() => false);
}

/** Soket bu tuvalin odasinda mi? Ucuz ve sahtelenemez. */
function inCanvasRoom(socket: HandlerSocket, channelId: string): boolean {
  return Boolean(channelId) && socket.rooms.has(`draw:${channelId}`);
}

// ── Ana handler ───────────────────────────────────────────────────────────────

export function registerDrawTogetherHandlers(
  socket: HandlerSocket,
  io:     HandlerServer,
  user:   { _id: string; displayName: string; avatarColor: string },
): void {

  const joinedCanvasChannels = new Set<string>();

  // ── draw:join — aktiviteye katıl, mevcut state'i al ───────────────────────
  // activity:join zaten activities.ts tarafından işlenmiş; bu event
  // canvas state'ini getirmek için ayrıca gönderilir.
  socket.on('draw:join', isolateSocketHandler(socket, 'draw:join', async (payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { channelId, sessionId } = payload as { channelId?: unknown; sessionId?: unknown };
    if (typeof channelId !== 'string' || !channelId || channelId.length > MAX_STROKE_ID_LEN ||
        typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_STROKE_ID_LEN) return;
    if (!await mayJoinCanvas(socket, user._id, channelId)) return;

    const state = await drawStore.withLock(channelId, async () => {
      let session = await drawStore.get(channelId);
      if (!session) {
        session = {
          sessionId,
          channelId,
          strokes: [],
          activeStrokes: new Map(),
          participants: new Map(),
          createdAt: Date.now(),
          hostSocketId: socket.id,
        };
        logger.info(`[draw-together] session created — channel:${channelId}`);
      } else if (session.sessionId !== sessionId) {
        // A stale/wrong client session id must not join another live activity.
        throw new Error('Draw session id mismatch');
      }
      session.participants.set(socket.id, {
        userId: user._id, displayName: user.displayName, color: user.avatarColor,
      });
      await drawStore.set(channelId, session);
      return serializeSession(session);
    });

    joinedCanvasChannels.add(channelId);
    socket.join(`draw:${channelId}`);
    socket.emit('draw:state', state);
    socket.to(`draw:${channelId}`).emit('draw:participant-joined', {
      userId: user._id, displayName: user.displayName, color: user.avatarColor,
    });
  }));

  // ── draw:stroke — stroke başladı veya devam ediyor (mouse/touch drag) ────
  socket.on('draw:stroke', isolateSocketHandler(socket, 'draw:stroke', async (data: Partial<DrawStroke> & { channelId: string; strokeId?: string }) => {
    if (!data || typeof data !== 'object') return;
    const { channelId, strokeId, ...rawStrokeData } = data;
    if (!inCanvasRoom(socket, channelId)) return;
    const id = rawStrokeData.id ?? strokeId;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_STROKE_ID_LEN) {
      socket.emit('draw:error', { message: 'Geçersiz stroke.id' });
      return;
    }

    const outcome = await drawStore.withLock(channelId, async () => {
      const session = await drawStore.get(channelId);
      if (!session || !session.participants.has(socket.id)) return null;

      // The bundled draw client sends a complete first frame followed by small
      // point-only frames carrying `strokeId`. Preserve that wire contract while
      // validating each update before it reaches shared state or other clients.
      const active = session.activeStrokes.get(socket.id);
      const isPointUpdate = active?.id === id
        && rawStrokeData.tool === undefined
        && rawStrokeData.color === undefined
        && rawStrokeData.size === undefined;
      if (isPointUpdate) {
        const error = validatePoints(rawStrokeData.points);
        if (error) return { error };
        active.points = rawStrokeData.points!;
        await drawStore.set(channelId, session);
        return { stroke: { ...active } };
      }

      const strokeData: Partial<DrawStroke> = { ...rawStrokeData, id };
      const error = validateStroke(strokeData);
      if (error) return { error };
      const stroke: DrawStroke = {
        id, tool: strokeData.tool!, color: strokeData.color!, size: strokeData.size!,
        opacity: strokeData.opacity!, points: strokeData.points!, text: strokeData.text,
        userId: user._id, displayName: user.displayName, ts: Date.now(), complete: false,
      };
      session.activeStrokes.set(socket.id, stroke);
      await drawStore.set(channelId, session);
      return { stroke };
    });
    if (outcome?.error) {
      socket.emit('draw:error', { message: outcome.error });
      return;
    }
    if (outcome?.stroke) socket.to(`draw:${channelId}`).emit('draw:stroke', outcome.stroke);
  }));

  // ── draw:stroke-end — kullanıcı fare/parmağı bıraktı ─────────────────────
  socket.on('draw:stroke-end', isolateSocketHandler(socket, 'draw:stroke-end', async (data: { channelId: string; strokeId: string; points?: DrawPoint[] }) => {
    const { channelId, strokeId, points } = data;
    if (typeof strokeId !== 'string' || strokeId.length === 0 || strokeId.length > MAX_STROKE_ID_LEN || !inCanvasRoom(socket, channelId)) return;
    const changed = await drawStore.withLock(channelId, async () => {
      const session = await drawStore.get(channelId);
      if (!session || !session.participants.has(socket.id)) return false;
      const active = session.activeStrokes.get(socket.id);
      if (!active || active.id !== strokeId) return false;
      if (points) {
        const error = validatePoints(points);
        if (error) {
          socket.emit('draw:error', { message: error });
          return false;
        }
        active.points = points;
      }
      active.complete = true;
      session.activeStrokes.delete(socket.id);
      if (session.strokes.length >= MAX_STROKES_PER_SESSION) session.strokes.shift();
      session.strokes.push(active);
      await drawStore.set(channelId, session);
      return true;
    });
    if (changed) socket.to(`draw:${channelId}`).emit('draw:stroke-end', { strokeId, points });
  }));

  // ── draw:undo — son stroke'u geri al ─────────────────────────────────────
  socket.on('draw:undo', isolateSocketHandler(socket, 'draw:undo', async ({ channelId }: { channelId: string }) => {
    if (!inCanvasRoom(socket, channelId)) return;
    const removed = await drawStore.withLock(channelId, async () => {
      const session = await drawStore.get(channelId);
      if (!session || !session.participants.has(socket.id)) return null;
      let idx = -1;
      for (let i = session.strokes.length - 1; i >= 0; i--) {
        if (session.strokes[i]?.userId === user._id) { idx = i; break; }
      }
      if (idx === -1) return null;
      const [stroke] = session.strokes.splice(idx, 1);
      await drawStore.set(channelId, session);
      return stroke;
    });
    if (!removed) return;
    io.to(`draw:${channelId}`).emit('draw:undo', {
      strokeId: removed.id, byUserId: user._id, displayName: user.displayName,
    });
  }));

  // ── draw:clear — tüm canvas'ı temizle (host veya admin) ──────────────────
  socket.on('draw:clear', isolateSocketHandler(socket, 'draw:clear', async ({ channelId }: { channelId: string }) => {
    if (!inCanvasRoom(socket, channelId)) return;
    const cleared = await drawStore.withLock(channelId, async () => {
      const session = await drawStore.get(channelId);
      if (!session || !session.participants.has(socket.id)) return false;
      if (session.hostSocketId !== socket.id) {
        socket.emit('draw:error', { message: 'Canvas temizlemek için host yetkisi gerekli.' });
        return false;
      }
      session.strokes = [];
      session.activeStrokes.clear();
      await drawStore.set(channelId, session);
      return true;
    });
    if (!cleared) return;
    io.to(`draw:${channelId}`).emit('draw:clear', { byUserId: user._id, displayName: user.displayName, ts: Date.now() });
    logger.info(`[draw-together] canvas cleared — channel:${channelId} by:${user._id}`);
  }));

  // ── draw:tool — araç/renk/boyut değişimi (cursor indicator için) ──────────
  socket.on('draw:tool', isolateSocketHandler(socket, 'draw:tool', (state: ToolState & { channelId: string }) => {
    if (!state || typeof state !== 'object') return;
    const { channelId, ...toolState } = state;
    if (!inCanvasRoom(socket, channelId)) return;
    const error = validateToolState(toolState);
    if (error) {
      socket.emit('draw:error', { message: error });
      return;
    }
    // Diğerlerine hangi aracın seçildiğini bildir (cursor rengi vs.)
    socket.to(`draw:${channelId}`).emit('draw:tool', {
      userId:      user._id,
      displayName: user.displayName,
      tool: toolState.tool,
      color: toolState.color,
      size: toolState.size,
      ...(toolState.opacity === undefined ? {} : { opacity: toolState.opacity }),
    });
  }));

  // ── draw:cursor — cursor pozisyonu (throttle) ─────────────────────────────
  socket.on('draw:cursor', isolateSocketHandler(socket, 'draw:cursor', (data: { channelId: string; x: number; y: number }) => {
    if (!data || typeof data !== 'object') return;
    const { channelId, x, y } = data;
    if (!inCanvasRoom(socket, channelId)) return;
    if (!validatePoint({ x, y })) return;

    const now = Date.now();
    const last = cursorLastSent.get(socket.id) ?? 0;
    if (now - last < CURSOR_THROTTLE_MS) return;  // throttle
    cursorLastSent.set(socket.id, now);

    socket.to(`draw:${channelId}`).emit('draw:cursor', {
      userId:      user._id,
      displayName: user.displayName,
      x, y,
    });
  }));

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', async () => {
    cursorLastSent.delete(socket.id);
    const channels = [...joinedCanvasChannels];
    joinedCanvasChannels.clear();
    for (const channelId of channels) {
      const outcome = await drawStore.withLock(channelId, async () => {
        const session = await drawStore.get(channelId);
        if (!session || !session.participants.has(socket.id)) return null;
        const participant = session.participants.get(socket.id);
        session.participants.delete(socket.id);
        session.activeStrokes.delete(socket.id);
        let newHostSocketId: string | undefined;
        let newHostUserId: string | undefined;
        if (session.hostSocketId === socket.id) {
          newHostSocketId = session.participants.keys().next().value as string | undefined;
          if (newHostSocketId) {
            session.hostSocketId = newHostSocketId;
            newHostUserId = session.participants.get(newHostSocketId)?.userId;
          }
        }
        if (session.participants.size === 0) {
          await drawStore.del(channelId);
          return { ended: true, participant };
        }
        await drawStore.set(channelId, session);
        return { ended: false, participant, newHostSocketId, newHostUserId };
      });
      if (!outcome) continue;
      if (outcome.ended) {
        logger.info(`[draw-together] session ended — channel:${channelId}`);
        continue;
      }
      if (outcome.newHostSocketId) {
        io.to(`draw:${channelId}`).emit('draw:host-changed', {
          newHostSocketId: outcome.newHostSocketId, newHostUserId: outcome.newHostUserId,
        });
      }
      io.to(`draw:${channelId}`).emit('draw:participant-left', {
        userId: outcome.participant?.userId, displayName: outcome.participant?.displayName,
      });
    }
  }));
}

// ── Export: local single-node/test mirror (compatibility + tests) ─────────────
export { drawSessions };
