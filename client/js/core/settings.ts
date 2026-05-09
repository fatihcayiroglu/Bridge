export {};
// core/settings.js (split from app.js)
async function openServerGifModal() {
  if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');
  const modal = document.getElementById('server-gif-modal');
  modal.style.display = 'flex';
  await loadServerGifs();
}

async function loadServerGifs() {
  const container = document.getElementById('server-gif-grid');
  if (!container || !currentServer) return;
  container.innerHTML = '<div class="gif-loading">YÃ¼kleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/gifs`);
    const gifs = await r.json();
    if (!gifs.length) { container.innerHTML = '<div class="gif-loading">Bu sunucuya henÃ¼z GIF eklenmemiÅŸ.</div>'; return; }
    container.innerHTML = '';
    for (const g of gifs) {
      const item = document.createElement('div');
      item.className = 'server-gif-item';
      item.addEventListener('click', () => sendServerGif(API + g.url, g.name));
      const img = document.createElement('img');
      img.src = API + g.url;
      img.alt = g.name;
      img.loading = 'lazy';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'server-gif-name';
      nameDiv.textContent = g.name;
      const delBtn = document.createElement('button');
      delBtn.className = 'server-gif-delete';
      delBtn.title = 'Sil';
      delBtn.textContent = 'ğŸ—‘ï¸';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteServerGif(e, g._id); });
      item.appendChild(img);
      item.appendChild(nameDiv);
      item.appendChild(delBtn);
      container.appendChild(item);
    }
  } catch { container.innerHTML = '<div class="gif-loading">YÃ¼kleme baÅŸarÄ±sÄ±z.</div>'; }
}

function sendServerGif(url, name) {
  document.getElementById('server-gif-modal').style.display = 'none';
  document.getElementById('emoji-picker').style.display = 'none';
  const inp = document.getElementById('msg-input');
  inp.value = url;
  sendMessage();
}

async function uploadServerGif() {
  if (!currentServer) return;
  const name = document.getElementById('server-gif-name')?.value?.trim();
  const tagsInput = document.getElementById('server-gif-tags')?.value?.trim();
  const fileInput = document.getElementById('server-gif-file');
  const file = fileInput?.files?.[0];
  if (!name) return toast('GIF adÄ± gerekli', 'error');
  if (!file) return toast('Dosya seÃ§in', 'error');
  if (file.size > 8 * 1024 * 1024) return toast('Max 8MB', 'error');

  // First upload the file
  const formData = new FormData(); formData.append('gif', file);
  const uploadR = await fetch(`${API}/api/upload/server-gif`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
  const uploadData = await uploadR.json();
  if (!uploadR.ok) return toast(uploadData.error || 'Upload failed', 'error');

  // Then save metadata
  const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/gifs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, tags, url: uploadData.url, fileType: uploadData.fileType }) });
  const data = await r.json();
  if (!r.ok) return toast(data.error, 'error');
  toast(`"${name}" eklendi!`, 'success');
  { const _t = document.getElementById('server-gif-name') as HTMLInputElement | null; if (_t) _t.value = ''; }
  { const _t = document.getElementById('server-gif-tags') as HTMLInputElement | null; if (_t) _t.value = ''; }
  if (fileInput) fileInput.value = '';
  await loadServerGifs();
}

async function deleteServerGif(e, gifId) {
  e.stopPropagation();
  if (!currentServer) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/gifs/${gifId}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('GIF silindi', 'success');
  await loadServerGifs();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CROSS-SERVER GIF PANEL (in emoji picker)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadAllServerGifs() {
  const grid = document.getElementById('server-gif-panel-grid');
  if (!grid) return;
}


// ══════════════════════════════════════════════════════════════
// SUNUCU KONTROL PANELİ (Electron)
// window.serverControl → electron/preload.js üzerinden IPC
// ══════════════════════════════════════════════════════════════

const SC_STATUS_COLORS: Record<string, string> = {
  stopped:  '#747f8d',
  starting: '#faa61a',
  running:  '#23a55a',
  error:    '#ed4245',
};

const SC_STATUS_LABELS: Record<string, string> = {
  stopped:  'Durduruldu',
  starting: 'Başlatılıyor…',
  running:  'Çalışıyor',
  error:    'Hata',
};

function scUpdateUI(status: string, pid: number | null) {
  const dot  = document.getElementById('sc-status-dot');
  const text = document.getElementById('sc-status-text');
  const pidEl = document.getElementById('sc-pid-text');
  const btnStart   = document.getElementById('sc-btn-start')   as HTMLButtonElement | null;
  const btnStop    = document.getElementById('sc-btn-stop')    as HTMLButtonElement | null;
  const btnRestart = document.getElementById('sc-btn-restart') as HTMLButtonElement | null;

  if (dot)  dot.style.background = SC_STATUS_COLORS[status] ?? '#747f8d';
  if (text) text.textContent = SC_STATUS_LABELS[status] ?? status;
  if (pidEl) pidEl.textContent = pid ? `PID: ${pid}` : '';

  const running = status === 'running';
  const stopped = status === 'stopped' || status === 'error';
  if (btnStart)   btnStart.disabled   = !stopped;
  if (btnStop)    btnStop.disabled    = !running;
  if (btnRestart) btnRestart.disabled = stopped;
}

function scAppendLog(entry: { t: number; level: string; line: string }) {
  const area = document.getElementById('sc-log-area');
  if (!area) return;

  // İlk açılışta placeholder'ı temizle
  if (area.querySelector('div[style*="italic"]')) area.innerHTML = '';

  const color = entry.level === 'error' ? '#ed4245' : '#e3e5e8';
  const time  = new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line  = document.createElement('div');
  line.style.color = color;
  line.textContent = `[${time}] ${entry.line}`;
  area.appendChild(line);

  // Otomatik scroll
  area.scrollTop = area.scrollHeight;
}

let _scStatusCb: ((d: any) => void) | null = null;
let _scLogCb:    ((d: any) => void) | null = null;

async function openServerControlPanel() {
  const sc = (window as any).serverControl;
  if (!sc) {
    toast('Sunucu kontrolü sadece masaüstü uygulamasında kullanılabilir.', 'error');
    return;
  }

  openModal('server-control-modal');

  // Mevcut durumu al
  const { status, pid, logs } = await sc.getStatus();
  scUpdateUI(status, pid);

  // Geçmiş logları doldur
  const area = document.getElementById('sc-log-area');
  if (area && logs?.length) {
    area.innerHTML = '';
    logs.forEach(scAppendLog);
  }

  // IPC listener'ları bağla (öncekini temizle)
  if (_scStatusCb) sc.offStatus(_scStatusCb);
  if (_scLogCb)    sc.offLog(_scLogCb);

  _scStatusCb = (d: any) => scUpdateUI(d.status, d.pid);
  _scLogCb    = (d: any) => scAppendLog(d);

  sc.onStatus(_scStatusCb);
  sc.onLog(_scLogCb);
}

function scStart()   { (window as any).serverControl?.start(); }
function scStop()    { (window as any).serverControl?.stop(); }
function scRestart() { (window as any).serverControl?.restart(); }

function scClearLogs() {
  const area = document.getElementById('sc-log-area');
  if (area) area.innerHTML = '<div style="color:#747f8d;font-style:italic;">Loglar temizlendi.</div>';
}

// Electron ise settings'e "Sunucu" butonu ekle (sayfa yüklenince)
document.addEventListener('DOMContentLoaded', () => {
  if (!(window as any).serverControl) return;
  // Araçlar bölümüne sunucu butonu ekle
  const toolsSection = document.querySelector('#settings-modal .modal-footer');
  if (!toolsSection) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.style.cssText = 'flex:1;gap:8px;';
  btn.textContent = '🖥️ Sunucu';
  btn.onclick = () => { closeModal('settings-modal'); openServerControlPanel(); };
  toolsSection.prepend(btn);
});

(window as any).openServerControlPanel = openServerControlPanel;
(window as any).scStart   = scStart;
(window as any).scStop    = scStop;
(window as any).scRestart = scRestart;
(window as any).scClearLogs = scClearLogs;
