// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/CanvasPanel.svelte
//              client/js/core/canvas-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/canvas.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Shared Canvas / Whiteboard — realtime çizim tahtası

import { BridgeRegistry } from './bridge-registry.js';

// ── Tip tanımları ─────────────────────────────────────────────

interface Point { x: number; y: number; }

type DrawTool = 'pen' | 'eraser' | 'line' | 'rect' | 'circle' | 'text';

interface Stroke {
  id: string;
  tool: DrawTool;
  color: string;
  width: number;
  points: Point[];
  text?: string;
}

interface SocketLike {
  on(event: string, cb: (data: Record<string, unknown>) => void): void;
  emit(event: string, data: Record<string, unknown>): void;
}

// ── Sabitler ─────────────────────────────────────────────────

const COLORS: string[] = [
  '#ffffff','#ff4757','#ff6b81','#ffa502','#ffdd59',
  '#7bed9f','#2ed573','#1e90ff','#70a1ff','#a29bfe',
  '#fd79a8','#636e72','#b2bec3','#000000',
];

const TOOLS: DrawTool[] = ['pen','eraser','line','rect','circle','text'];

const TOOL_ICONS: Record<DrawTool, string> = {
  pen: '✏️', eraser: '⬜', line: '╱', rect: '▭', circle: '○', text: 'T',
};

// ── State ─────────────────────────────────────────────────────

let socket: SocketLike | null = null;
let currentCh: string | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let drawing = false;
let currentTool: DrawTool = 'pen';
let currentColor = '#ffffff';
let currentWidth = 3;
let currentPoints: Point[] = [];
let activeStrokeId: string | null = null;
let history: string[] = [];

// ── Init ──────────────────────────────────────────────────────

export function init(io: SocketLike): void {
  socket = io;
  _bindSocketEvents();
}

function _bindSocketEvents(): void {
  if (!socket) return;
  socket.on('canvas:state-sync', ({ channelId, strokes }) => {
    if (channelId !== currentCh) return;
    clearLocal();
    (strokes as Stroke[]).forEach(drawStroke);
  });
  socket.on('canvas:draw', ({ channelId, stroke }) => {
    if (channelId !== currentCh) return;
    drawStroke(stroke as Stroke);
  });
  socket.on('canvas:stroke-delete', ({ channelId }) => {
    if (channelId !== currentCh) return;
    socket!.emit('canvas:state-request', { channelId: currentCh! });
  });
  socket.on('canvas:clear', ({ channelId }) => {
    if (channelId !== currentCh) return;
    clearLocal();
  });
}

// ── Panel ─────────────────────────────────────────────────────

export function openPanel(channelId: string): void {
  currentCh = channelId;
  _ensurePanel();
  document.getElementById('canvas-panel')?.classList.remove('hidden');
  socket?.emit('canvas:join', { channelId });
}

export function closePanel(): void {
  if (currentCh) socket?.emit('canvas:leave', { channelId: currentCh });
  document.getElementById('canvas-panel')?.classList.add('hidden');
  currentCh = null;
}

function _ensurePanel(): void {
  if (document.getElementById('canvas-panel')) { _resizeCanvas(); return; }

  const panel = document.createElement('div');
  panel.id = 'canvas-panel';
  panel.className = 'canvas-panel hidden';
  panel.innerHTML = `
    <div class="canvas-toolbar">
      <div class="canvas-tools">
        ${TOOLS.map(t => `<button class="canvas-tool-btn ${t === 'pen' ? 'active' : ''}" data-tool="${t}" title="${t}">${TOOL_ICONS[t]}</button>`).join('')}
      </div>
      <div class="canvas-colors">
        ${COLORS.map(c => `<button class="canvas-color-btn" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      </div>
      <div class="canvas-size">
        <input type="range" id="canvas-width" min="1" max="40" value="3" title="Fırça kalınlığı">
      </div>
      <div class="canvas-actions">
        <button class="canvas-btn" id="canvas-undo" title="Geri al">↩</button>
        <button class="canvas-btn canvas-btn-danger" id="canvas-clear" title="Tümünü temizle">🗑️</button>
        <button class="canvas-btn" id="canvas-close" title="Kapat">✕</button>
      </div>
    </div>
    <canvas id="canvas-board"></canvas>`;
  document.body.appendChild(panel);

  canvas = panel.querySelector<HTMLCanvasElement>('#canvas-board')!;
  ctx    = canvas.getContext('2d')!;
  _resizeCanvas();

  panel.querySelectorAll<HTMLButtonElement>('.canvas-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.canvas-tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool as DrawTool;
      if (canvas) canvas.style.cursor = currentTool === 'eraser' ? 'cell' : 'crosshair';
    });
  });

  panel.querySelectorAll<HTMLButtonElement>('.canvas-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.canvas-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color ?? '#ffffff';
    });
  });
  panel.querySelector<HTMLButtonElement>('[data-color="#ffffff"]')?.classList.add('active');

  panel.querySelector<HTMLInputElement>('#canvas-width')?.addEventListener('input', e => {
    currentWidth = +(e.target as HTMLInputElement).value;
  });

  document.getElementById('canvas-undo')?.addEventListener('click', () => {
    const id = history.pop();
    if (id && currentCh) socket?.emit('canvas:stroke-delete', { channelId: currentCh, strokeId: id });
  });

  document.getElementById('canvas-clear')?.addEventListener('click', () => {
    if (confirm('Tüm çizimler silinsin mi?') && currentCh) {
      socket?.emit('canvas:clear', { channelId: currentCh });
    }
  });

  document.getElementById('canvas-close')?.addEventListener('click', closePanel);

  canvas.addEventListener('mousedown',  _startDraw as EventListener);
  canvas.addEventListener('mousemove',  _moveDraw as EventListener);
  canvas.addEventListener('mouseup',    _endDraw);
  canvas.addEventListener('mouseleave', _endDraw);
  canvas.addEventListener('touchstart', e => { e.preventDefault(); _startDraw(_touchToMouse(e as TouchEvent) as unknown as MouseEvent); }, { passive: false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); _moveDraw(_touchToMouse(e as TouchEvent) as unknown as MouseEvent);  }, { passive: false });
  canvas.addEventListener('touchend',   _endDraw);

  window.addEventListener('resize', _resizeCanvas);
}

function _resizeCanvas(): void {
  if (!canvas) return;
  const panel = document.getElementById('canvas-panel') as HTMLElement | null;
  if (!panel || panel.classList.contains('hidden')) return;
  const tb = panel.querySelector<HTMLElement>('.canvas-toolbar')?.offsetHeight ?? 0;
  canvas.width  = panel.offsetWidth;
  canvas.height = panel.offsetHeight - tb;
  if (currentCh) socket?.emit('canvas:state-request', { channelId: currentCh });
}

// ── Drawing ───────────────────────────────────────────────────

function _startDraw(e: MouseEvent): void {
  drawing = true;
  currentPoints = [_getPos(e)];
  activeStrokeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (currentTool === 'text') {
    const text = prompt('Metin:');
    if (!text) { drawing = false; return; }
    const stroke = _buildStroke([_getPos(e)], text);
    drawStroke(stroke);
    if (currentCh) socket?.emit('canvas:draw', { channelId: currentCh, stroke });
    history.push(stroke.id);
    drawing = false;
  }
}

function _moveDraw(e: MouseEvent): void {
  if (!drawing || !ctx) return;
  currentPoints.push(_getPos(e));
  if (currentTool === 'pen' || currentTool === 'eraser') {
    const preview = _buildStroke(currentPoints);
    // Redraw only last segment for performance
    ctx.save();
    ctx.strokeStyle = currentTool === 'eraser' ? '#000000' : currentColor;
    if (currentTool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = currentWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = currentPoints;
    if (pts.length >= 2) {
      ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }
    ctx.restore();
    if (currentCh) socket?.emit('canvas:draw-preview', { channelId: currentCh, stroke: preview });
  }
}

function _endDraw(): void {
  if (!drawing) return;
  drawing = false;
  if (!currentPoints.length || !currentCh) return;
  const stroke = _buildStroke(currentPoints);
  drawStroke(stroke);
  socket?.emit('canvas:draw', { channelId: currentCh, stroke: stroke as unknown as Record<string, unknown> });
  history.push(stroke.id);
  currentPoints = [];
  activeStrokeId = null;
}

function _buildStroke(points: Point[], text?: string): Stroke {
  return {
    id:     activeStrokeId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tool:   currentTool,
    color:  currentColor,
    width:  currentWidth,
    points,
    ...(text !== undefined ? { text } : {}),
  };
}

// ── Render ────────────────────────────────────────────────────

export function drawStroke(s: Stroke): void {
  if (!ctx) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle   = s.color;
  ctx.lineWidth   = s.width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  const pts = s.points;
  if (!pts?.length) { ctx.restore(); return; }

  switch (s.tool) {
    case 'pen':
    case 'eraser':
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
      break;
    case 'rect': {
      const x = Math.min(pts[0].x, pts[pts.length-1].x);
      const y = Math.min(pts[0].y, pts[pts.length-1].y);
      const w = Math.abs(pts[pts.length-1].x - pts[0].x);
      const h = Math.abs(pts[pts.length-1].y - pts[0].y);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case 'circle': {
      const cx = (pts[0].x + pts[pts.length-1].x) / 2;
      const cy = (pts[0].y + pts[pts.length-1].y) / 2;
      const r  = Math.hypot(pts[pts.length-1].x - pts[0].x, pts[pts.length-1].y - pts[0].y) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text':
      ctx.font = `${Math.max(s.width * 6, 14)}px sans-serif`;
      ctx.fillText(s.text ?? '', pts[0].x, pts[0].y);
      break;
  }
  ctx.restore();
}

export function clearLocal(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  history = [];
}

// ── Helpers ───────────────────────────────────────────────────

function _getPos(e: MouseEvent): Point {
  const rect = canvas!.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _touchToMouse(e: TouchEvent): { clientX: number; clientY: number } {
  const t = e.touches[0];
  return { clientX: t.clientX, clientY: t.clientY };
}

// ── Public ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
BridgeRegistry.register('CanvasUI', { init, open: openPanel, close: closePanel } as unknown);

document.addEventListener('click', (e: Event) => {
  const btn = (e.target as HTMLElement).closest('#btn-canvas');
  if (!btn) return;
  const chId = BridgeRegistry.get('currentChannelId') as string | null;
  if (chId) openPanel(chId);
});

export const getCanvasUI = (): { init: typeof init; open: typeof openPanel; close: typeof closePanel } | null =>
  BridgeRegistry.get('CanvasUI') as { init: typeof init; open: typeof openPanel; close: typeof closePanel } | null;
