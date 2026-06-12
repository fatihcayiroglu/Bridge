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
// Production'da Redis pub/sub ile multi-node desteği eklenebilir.

import type { Socket, Server as IOServer } from 'socket.io';
import logger from '../../../lib/logger';

// ── Sabitler ──────────────────────────────────────────────────────────────────
const MAX_STROKES_PER_SESSION = 1000;  // bellek sınırı
const MAX_POINTS_PER_STROKE   = 500;   // tek stroke max koordinat sayısı
const CURSOR_THROTTLE_MS      = 50;    // cursor event min aralığı (ms)
const VALID_TOOLS             = new Set(['pen', 'eraser', 'line', 'rect', 'circle', 'fill', 'text']);
const MAX_COLOR_LEN           = 9;     // #rrggbbaa
const MAX_TEXT_LEN            = 200;

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

interface DrawSession {
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
  opacity: number;
}

// ── Session store ─────────────────────────────────────────────────────────────
// Key: channelId (activities.ts zaten session başlatıyor; draw-together
// session zaten activity:start ile açılmış durumda)
const drawSessions = new Map<string, DrawSession>();

// Cursor throttle per socket
const cursorLastSent = new Map<string, number>();

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function getSession(channelId: string): DrawSession | null {
  return drawSessions.get(channelId) ?? null;
}

function serializeSession(s: DrawSession) {
  return {
    sessionId:   s.sessionId,
    channelId:   s.channelId,
    strokes:     s.strokes,
    participants: [...s.participants.values()],
    createdAt:   s.createdAt,
  };
}

function validateStroke(data: Partial<DrawStroke>): string | null {
  if (!data.id || typeof data.id !== 'string') return 'stroke.id gerekli';
  if (!data.tool || !VALID_TOOLS.has(data.tool)) return `Geçersiz tool: ${data.tool}`;
  if (!data.color || typeof data.color !== 'string') return 'color gerekli';
  if (data.color.length > MAX_COLOR_LEN || !/^#[0-9a-fA-F]{3,8}$/.test(data.color))
    return 'Geçersiz color formatı';
  if (typeof data.size !== 'number' || data.size < 1 || data.size > 100) return 'size: 1–100';
  if (typeof data.opacity !== 'number' || data.opacity < 0 || data.opacity > 1) return 'opacity: 0–1';
  if (!Array.isArray(data.points) || data.points.length === 0) return 'points gerekli';
  if (data.points.length > MAX_POINTS_PER_STROKE) return 'Çok fazla nokta';
  if (data.tool === 'text' && data.text && data.text.length > MAX_TEXT_LEN) return 'Metin çok uzun';
  for (const p of data.points) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return 'Geçersiz nokta formatı';
  }
  return null;
}

// ── Ana handler ───────────────────────────────────────────────────────────────

export function registerDrawTogetherHandlers(
  socket: Socket,
  io:     IOServer,
  user:   { _id: string; displayName: string; avatarColor: string },
): void {

  // ── draw:join — aktiviteye katıl, mevcut state'i al ───────────────────────
  // activity:join zaten activities.ts tarafından işlenmiş; bu event
  // canvas state'ini getirmek için ayrıca gönderilir.
  socket.on('draw:join', ({ channelId, sessionId }: { channelId: string; sessionId: string }) => {
    if (!channelId || !sessionId) return;

    let session = drawSessions.get(channelId);

    if (!session) {
      // Session yoksa oluştur (host bu kullanıcı olur)
      session = {
        sessionId,
        channelId,
        strokes:      [],
        activeStrokes: new Map(),
        participants:  new Map(),
        createdAt:    Date.now(),
        hostSocketId: socket.id,
      };
      drawSessions.set(channelId, session);
      logger.info(`[draw-together] session created — channel:${channelId}`);
    }

    // Katılımcı listesine ekle
    session.participants.set(socket.id, {
      userId:      user._id,
      displayName: user.displayName,
      color:       user.avatarColor,
    });

    socket.join(`draw:${channelId}`);

    // Yeni katılan kullanıcıya mevcut state'i gönder
    socket.emit('draw:state', serializeSession(session));

    // Diğerlerine yeni katılımı bildir
    socket.to(`draw:${channelId}`).emit('draw:participant-joined', {
      userId:      user._id,
      displayName: user.displayName,
      color:       user.avatarColor,
    });
  });

  // ── draw:stroke — stroke başladı veya devam ediyor (mouse/touch drag) ────
  socket.on('draw:stroke', (data: Partial<DrawStroke> & { channelId: string }) => {
    const { channelId, ...strokeData } = data;
    if (!channelId) return;

    const session = getSession(channelId);
    if (!session) return;

    const err = validateStroke(strokeData);
    if (err) { socket.emit('draw:error', { message: err }); return; }

    const stroke: DrawStroke = {
      id:          strokeData.id!,
      tool:        strokeData.tool!,
      color:       strokeData.color!,
      size:        strokeData.size!,
      opacity:     strokeData.opacity ?? 1,
      points:      strokeData.points!,
      text:        strokeData.text,
      userId:      user._id,
      displayName: user.displayName,
      ts:          Date.now(),
      complete:    false,
    };

    // In-progress stroke güncelle (delta broadcast için)
    session.activeStrokes.set(socket.id, stroke);

    // Diğer katılımcılara yayınla (gönderenin kendisine değil)
    socket.to(`draw:${channelId}`).emit('draw:stroke', { ...stroke });
  });

  // ── draw:stroke-end — kullanıcı fare/parmağı bıraktı ─────────────────────
  socket.on('draw:stroke-end', (data: { channelId: string; strokeId: string; points?: DrawPoint[] }) => {
    const { channelId, strokeId, points } = data;
    if (!channelId || !strokeId) return;

    const session = getSession(channelId);
    if (!session) return;

    const active = session.activeStrokes.get(socket.id);
    if (active && active.id === strokeId) {
      if (points) active.points = points; // son nokta listesi
      active.complete = true;
      session.activeStrokes.delete(socket.id);

      // Tamamlanmış stroke'u buffer'a ekle
      if (session.strokes.length < MAX_STROKES_PER_SESSION) {
        session.strokes.push(active);
      } else {
        // En eski stroke'u at (ring buffer benzeri davranış)
        session.strokes.shift();
        session.strokes.push(active);
      }
    }

    socket.to(`draw:${channelId}`).emit('draw:stroke-end', { strokeId, points });
  });

  // ── draw:undo — son stroke'u geri al ─────────────────────────────────────
  socket.on('draw:undo', ({ channelId }: { channelId: string }) => {
    if (!channelId) return;

    const session = getSession(channelId);
    if (!session) return;

    // Sadece bu kullanıcının son stroke'unu bul
    let idx = -1;
    for (let i = session.strokes.length - 1; i >= 0; i--) {
      if (session.strokes[i].userId === user._id) { idx = i; break; }
    }

    if (idx === -1) return; // geri alacak stroke yok

    const [removed] = session.strokes.splice(idx, 1);

    // Kanala bildir
    io.to(`draw:${channelId}`).emit('draw:undo', {
      strokeId:    removed.id,
      byUserId:    user._id,
      displayName: user.displayName,
    });
  });

  // ── draw:clear — tüm canvas'ı temizle (host veya admin) ──────────────────
  socket.on('draw:clear', ({ channelId }: { channelId: string }) => {
    if (!channelId) return;

    const session = getSession(channelId);
    if (!session) return;

    const isHost = session.hostSocketId === socket.id;
    if (!isHost) {
      socket.emit('draw:error', { message: 'Canvas temizlemek için host yetkisi gerekli.' });
      return;
    }

    session.strokes = [];
    session.activeStrokes.clear();

    io.to(`draw:${channelId}`).emit('draw:clear', {
      byUserId:    user._id,
      displayName: user.displayName,
      ts:          Date.now(),
    });

    logger.info(`[draw-together] canvas cleared — channel:${channelId} by:${user._id}`);
  });

  // ── draw:tool — araç/renk/boyut değişimi (cursor indicator için) ──────────
  socket.on('draw:tool', (state: ToolState & { channelId: string }) => {
    const { channelId, ...toolState } = state;
    if (!channelId) return;
    // Diğerlerine hangi aracın seçildiğini bildir (cursor rengi vs.)
    socket.to(`draw:${channelId}`).emit('draw:tool', {
      userId:      user._id,
      displayName: user.displayName,
      ...toolState,
    });
  });

  // ── draw:cursor — cursor pozisyonu (throttle) ─────────────────────────────
  socket.on('draw:cursor', ({ channelId, x, y }: { channelId: string; x: number; y: number }) => {
    if (!channelId) return;

    const now = Date.now();
    const last = cursorLastSent.get(socket.id) ?? 0;
    if (now - last < CURSOR_THROTTLE_MS) return;  // throttle
    cursorLastSent.set(socket.id, now);

    socket.to(`draw:${channelId}`).emit('draw:cursor', {
      userId:      user._id,
      displayName: user.displayName,
      x, y,
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    cursorLastSent.delete(socket.id);

    for (const [channelId, session] of drawSessions) {
      if (!session.participants.has(socket.id)) continue;

      const participant = session.participants.get(socket.id);
      session.participants.delete(socket.id);
      session.activeStrokes.delete(socket.id);

      // Host ayrıldıysa sıradaki katılımcıyı host yap
      if (session.hostSocketId === socket.id) {
        const next = session.participants.keys().next().value as string | undefined;
        if (next) {
          session.hostSocketId = next;
          io.to(`draw:${channelId}`).emit('draw:host-changed', {
            newHostSocketId: next,
            newHostUserId:   session.participants.get(next)?.userId,
          });
        }
      }

      // Session boşsa temizle
      if (session.participants.size === 0) {
        drawSessions.delete(channelId);
        logger.info(`[draw-together] session ended — channel:${channelId}`);
      } else {
        io.to(`draw:${channelId}`).emit('draw:participant-left', {
          userId:      participant?.userId,
          displayName: participant?.displayName,
        });
      }
    }
  });
}

// ── Export: session erişimi (activity:end hook için) ─────────────────────────
export { drawSessions };
