// client/js/core/canvas.js
// Shared Canvas / Whiteboard — realtime çizim tahtası
// Kanal header'ında 🎨 butonuyla açılır; panel olarak görünür.

'use strict';

(function () {
  const COLORS = ['#ffffff','#ff4757','#ff6b81','#ffa502','#ffdd59',
                   '#7bed9f','#2ed573','#1e90ff','#70a1ff','#a29bfe',
                   '#fd79a8','#636e72','#b2bec3','#000000'];
  const TOOLS  = ['pen','eraser','line','rect','circle','text'];

  let socket        = null;
  let currentCh     = null;
  let canvas        = null;
  let ctx           = null;
  let drawing       = false;
  let currentTool   = 'pen';
  let currentColor  = '#ffffff';
  let currentWidth  = 3;
  let currentPoints = [];
  let activeStrokeId = null;
  let history       = []; // local undo stack (stroke ids)

  // ── Init ──────────────────────────────────────────────────────
  function init(io) {
    socket = io;
    bindSocketEvents();
  }

  function bindSocketEvents() {
    socket.on('canvas:state-sync', ({ channelId, strokes }) => {
      if (channelId !== currentCh) return;
      clearLocal();
      strokes.forEach(drawStroke);
    });

    socket.on('canvas:draw', ({ channelId, stroke }) => {
      if (channelId !== currentCh) return;
      drawStroke(stroke);
    });

    socket.on('canvas:stroke-delete', ({ channelId, strokeId }) => {
      if (channelId !== currentCh) return;
      // Full redraw (simplest correct approach for <2000 strokes)
      socket.emit('canvas:state-request', { channelId });
    });

    socket.on('canvas:clear', ({ channelId }) => {
      if (channelId !== currentCh) return;
      clearLocal();
    });
  }

  // ── Panel ─────────────────────────────────────────────────────
  function openPanel(channelId) {
    currentCh = channelId;
    ensurePanel();
    document.getElementById('canvas-panel').classList.remove('hidden');
    socket.emit('canvas:join', { channelId });
  }

  function closePanel() {
    if (currentCh) socket.emit('canvas:leave', { channelId: currentCh });
    document.getElementById('canvas-panel')?.classList.add('hidden');
    currentCh = null;
  }

  function ensurePanel() {
    if (document.getElementById('canvas-panel')) {
      resizeCanvas(); return;
    }

    const panel = document.createElement('div');
    panel.id = 'canvas-panel';
    panel.className = 'canvas-panel hidden';
    panel.innerHTML = `
      <div class="canvas-toolbar">
        <div class="canvas-tools">
          ${TOOLS.map(t => `<button class="canvas-tool-btn ${t==='pen'?'active':''}" data-tool="${t}" title="${t}">
            ${{pen:'✏️',eraser:'⬜',line:'╱',rect:'▭',circle:'○',text:'T'}[t]}
          </button>`).join('')}
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

    canvas = panel.querySelector('#canvas-board');
    ctx    = canvas.getContext('2d');
    resizeCanvas();

    // Tool buttons
    panel.querySelectorAll('.canvas-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.canvas-tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
        canvas.style.cursor = currentTool === 'eraser' ? 'cell' : 'crosshair';
      });
    });

    // Color buttons
    panel.querySelectorAll('.canvas-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.canvas-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
      });
    });
    panel.querySelector('[data-color="#ffffff"]').classList.add('active');

    // Width
    panel.querySelector('#canvas-width').addEventListener('input', e => {
      currentWidth = +e.target.value;
    });

    // Undo
    document.getElementById('canvas-undo').addEventListener('click', () => {
      const id = history.pop();
      if (id) socket.emit('canvas:stroke-delete', { channelId: currentCh, strokeId: id });
    });

    // Clear
    document.getElementById('canvas-clear').addEventListener('click', () => {
      if (confirm('Tüm çizimler silinsin mi?')) {
        socket.emit('canvas:clear', { channelId: currentCh });
      }
    });

    document.getElementById('canvas-close').addEventListener('click', closePanel);

    // Draw events
    canvas.addEventListener('mousedown',  startDraw);
    canvas.addEventListener('mousemove',  moveDraw);
    canvas.addEventListener('mouseup',    endDraw);
    canvas.addEventListener('mouseleave', endDraw);
    canvas.addEventListener('touchstart', e => { e.preventDefault(); startDraw(touchToMouse(e)); }, { passive: false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); moveDraw(touchToMouse(e));  }, { passive: false });
    canvas.addEventListener('touchend',   endDraw);

    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const panel = document.getElementById('canvas-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    const tb = panel.querySelector('.canvas-toolbar').offsetHeight;
    canvas.width  = panel.offsetWidth;
    canvas.height = panel.offsetHeight - tb;
    // Redraw after resize
    if (currentCh) socket.emit('canvas:state-request', { channelId: currentCh });
  }

  // ── Drawing ───────────────────────────────────────────────────
  function startDraw(e) {
    drawing = true;
    currentPoints = [getPos(e)];
    activeStrokeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (currentTool === 'text') {
      const text = prompt('Metin:');
      if (!text) { drawing = false; return; }
      const stroke = buildStroke([getPos(e)], text);
      drawStroke(stroke);
      history.push(stroke.id);
      socket.emit('canvas:draw', { channelId: currentCh, stroke });
      drawing = false;
    }
  }

  function moveDraw(e) {
    if (!drawing || currentTool === 'text') return;
    currentPoints.push(getPos(e));
    // Live preview for pen/eraser
    if (currentTool === 'pen' || currentTool === 'eraser') {
      previewStroke(currentPoints);
    }
  }

  function endDraw() {
    if (!drawing) return;
    drawing = false;
    if (currentPoints.length < 1) return;
    const stroke = buildStroke(currentPoints);
    drawStroke(stroke);
    history.push(stroke.id);
    socket.emit('canvas:draw', { channelId: currentCh, stroke });
    currentPoints = [];
  }

  function buildStroke(points, text) {
    return {
      id:    activeStrokeId || String(Date.now()),
      tool:  currentTool,
      color: currentTool === 'eraser' ? '#1a1a2e' : currentColor,
      width: currentTool === 'eraser' ? currentWidth * 4 : currentWidth,
      points,
      text:  text || undefined,
    };
  }

  function previewStroke(pts) {
    // Only redraw last segment for pen (performance)
    if (pts.length < 2) return;
    const p1 = pts[pts.length - 2];
    const p2 = pts[pts.length - 1];
    ctx.strokeStyle = currentTool === 'eraser' ? '#1a1a2e' : currentColor;
    ctx.lineWidth   = currentTool === 'eraser' ? currentWidth * 4 : currentWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  function drawStroke(s) {
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle   = s.color;
    ctx.lineWidth   = s.width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    const pts = s.points;
    if (!pts || !pts.length) { ctx.restore(); return; }

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
        ctx.fillText(s.text || '', pts[0].x, pts[0].y);
        break;
    }
    ctx.restore();
  }

  function clearLocal() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    history = [];
  }

  // ── Helpers ───────────────────────────────────────────────────
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
  }
  function touchToMouse(e) {
    const t = e.touches[0];
    return { clientX: t.clientX, clientY: t.clientY };
  }

  // ── Public ────────────────────────────────────────────────────
  window.CanvasUI = { init, open: openPanel, close: closePanel };

  // Header button hook
  document.addEventListener('click', e => {
    const btn = e.target.closest('#btn-canvas');
    if (!btn) return;
    const chId = window.currentChannelId || window.bridgeApp?.currentChannelId;
    if (chId) openPanel(chId);
  });
})();

export const getCanvasUI = () => window.CanvasUI;
