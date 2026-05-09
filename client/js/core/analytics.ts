// client/js/core/analytics.js Sunucu Ä°statistik Dashboard
// Sunucu baÅŸÄ±na mesaj/Ã¼ye/kanal grafikleri â€” Chart.js ile

'use strict';

// â”€â”€ Dashboard AÃ§ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openServerAnalytics() {
  if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');

  let modal = document.getElementById('analytics-modal');
  if (!modal) {
    modal = _buildAnalyticsModal();
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  await _loadAnalyticsData(currentServer._id);
}

function closeAnalyticsModal() {
  const modal = document.getElementById('analytics-modal');
  if (modal) modal.style.display = 'none';
  // Chart instance'larÄ±nÄ± temizle
  ['chart-daily', 'chart-channels'].forEach(id => {
    const canvas = document.getElementById(id);
    if (canvas && canvas._chartInstance) {
      canvas._chartInstance.destroy();
      canvas._chartInstance = null;
    }
  });
}

// â”€â”€ Modal HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _buildAnalyticsModal() {
  const el = document.createElement('div');
  el.id = 'analytics-modal';
  el.className = 'modal-overlay';
  el.style.cssText = 'display:none;z-index:1100;';
  el.onclick = e => { if (e.target === el) closeAnalyticsModal(); };
  el.innerHTML = `
    <div class="modal-card" style="max-width:640px;width:95%;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="margin:0;font-size:18px;">ğŸ“Š Sunucu Ä°statistikleri</h2>
        <button class="btn" onclick="closeAnalyticsModal()" style="padding:4px 10px;font-size:16px;">âœ•</button>
      </div>

      <div id="analytics-loading" style="text-align:center;padding:40px;color:var(--text-muted);">
        â³ YÃ¼kleniyor...
      </div>

      <div id="analytics-content" style="display:none;">
        <!-- Ã–zet kartlar -->
        <div id="analytics-summary" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;"></div>

        <!-- GÃ¼nlÃ¼k mesaj grafiÄŸi -->
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;margin-bottom:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0 0 12px;">Son 7 GÃ¼n â€” Mesaj Aktivitesi</h3>
          <canvas id="chart-daily" height="160"></canvas>
        </div>

        <!-- Top kanallar grafiÄŸi -->
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;margin-bottom:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0 0 12px;">En Aktif Kanallar</h3>
          <canvas id="chart-channels" height="160"></canvas>
        </div>

        <!-- Sahip: top Ã¼yeler -->
        <div id="analytics-top-members" style="display:none;background:var(--bg-3);border-radius:10px;padding:16px;margin-bottom:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0 0 12px;">En Aktif Ãœyeler (Son 7 GÃ¼n)</h3>
          <div id="analytics-members-list"></div>
        </div>

        <!-- Sahip: davet istatistikleri -->
        <div id="analytics-invites" style="display:none;background:var(--bg-3);border-radius:10px;padding:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0 0 12px;">Davet Ä°statistikleri</h3>
          <div id="analytics-invites-content"></div>
        </div>
      </div>
    </div>`;
  return el;
}

// â”€â”€ Veri YÃ¼kle ve Ã‡iz â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _loadAnalyticsData(serverId) {
  const loading = document.getElementById('analytics-loading');
  const content = document.getElementById('analytics-content');
  if (loading) loading.style.display = 'block';
  if (content) content.style.display = 'none';

  try {
    const r = await apiFetch(`${API}/api/health/server/${serverId}`);
    if (!r.ok) throw new Error('Veri alÄ±namadÄ±');
    const data = await r.json();

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';

    _renderSummary(data);
    _renderDailyChart(data);
    _renderChannelChart(data);
    if (data.topMembers) _renderTopMembers(data.topMembers);
    if (data.invites)    _renderInvites(data.invites);
  } catch (e) {
    if (loading) loading.innerHTML = `<span style="color:var(--red)">âŒ ${e.message}</span>`;
  }
}

function _renderSummary(data) {
  const el = document.getElementById('analytics-summary');
  if (!el) return;
  const items = [
    { icon: 'ğŸ‘¥', label: 'Ãœye',    value: data.members },
    { icon: 'ğŸ“¢', label: 'Kanal',  value: data.channels },
    { icon: 'ğŸ’¬', label: 'Mesaj',  value: data.totalMessages?.toLocaleString('tr-TR') },
    { icon: 'ğŸ“…', label: '7 GÃ¼n',  value: data.last7Days?.messages },
    { icon: 'ğŸ“†', label: 'KuruluÅŸ', value: data.createdAt ? new Date(data.createdAt).toLocaleDateString('tr-TR') : 'â€”' },
    { icon: 'ğŸ·ï¸', label: 'Sunucu', value: data.serverName },
  ];
  el.innerHTML = items.map(i => `
    <div style="background:var(--bg-3);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:22px;">${i.icon}</div>
      <div style="font-size:18px;font-weight:700;color:var(--text-primary);margin:4px 0;">${i.value ?? 'â€”'}</div>
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">${i.label}</div>
    </div>`).join('');
}

function _renderDailyChart(data) {
  const canvas = document.getElementById('chart-daily');
  if (!canvas) return;
  const daily = data.last7Days?.daily || {};
  const labels = Object.keys(daily).reverse();
  const values = Object.values(daily).reverse();

  // Chart.js yÃ¼kle (CDN)
  _ensureChartJS(() => {
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    canvas._chartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Mesaj',
          data: values,
          backgroundColor: 'rgba(88,101,242,0.7)',
          borderColor: 'rgba(88,101,242,1)',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#888', precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          x: { ticks: { color: '#888' }, grid: { display: false } },
        },
      },
    });
  });
}

function _renderChannelChart(data) {
  const canvas = document.getElementById('chart-channels');
  if (!canvas) return;
  const channels = data.topChannels || [];
  if (!channels.length) { canvas.parentElement.style.display = 'none'; return; }

  _ensureChartJS(() => {
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    canvas._chartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: channels.map(c => '#' + c.name),
        datasets: [{
          label: 'Mesaj',
          data: channels.map(c => c.messages),
          backgroundColor: [
            'rgba(88,101,242,0.8)','rgba(87,242,135,0.8)','rgba(254,231,92,0.8)',
            'rgba(237,66,69,0.8)','rgba(235,69,158,0.8)',
          ],
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { color: '#888', precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#888' }, grid: { display: false } },
        },
      },
    });
  });
}

function _renderTopMembers(members) {
  const wrap = document.getElementById('analytics-top-members');
  const list = document.getElementById('analytics-members-list');
  if (!wrap || !list || !members.length) return;
  wrap.style.display = 'block';
  list.innerHTML = members.map((m, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:18px;width:28px;text-align:center;">${['ğŸ¥‡','ğŸ¥ˆ','ğŸ¥‰','4ï¸âƒ£','5ï¸âƒ£'][i]||'â–ªï¸'}</span>
      <span style="flex:1;font-weight:600;">${escHtml(m.displayName || m.username)}</span>
      <span style="color:var(--text-muted);font-size:13px;">${m.messages} mesaj</span>
    </div>`).join('');
}

function _renderInvites(inv) {
  const wrap = document.getElementById('analytics-invites');
  const content = document.getElementById('analytics-invites-content');
  if (!wrap || !content) return;
  wrap.style.display = 'block';
  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
      <div style="text-align:center;"><div style="font-size:22px;font-weight:700;">${inv.total}</div><div style="font-size:11px;color:var(--text-muted);">TOPLAM</div></div>
      <div style="text-align:center;"><div style="font-size:22px;font-weight:700;color:var(--green);">${inv.active}</div><div style="font-size:11px;color:var(--text-muted);">AKTÄ°F</div></div>
      <div style="text-align:center;"><div style="font-size:22px;font-weight:700;">${inv.totalUses}</div><div style="font-size:11px;color:var(--text-muted);">KULLANIM</div></div>
    </div>`;
}

// â”€â”€ Chart.js lazy load â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _chartJsLoaded = false;
let _chartJsCallbacks = [];

function _ensureChartJS(cb) {
  if (_chartJsLoaded) { cb(); return; }
  _chartJsCallbacks.push(cb);
  if (document.getElementById('chartjs-script')) return;
  const s = document.createElement('script');
  s.id = 'chartjs-script';
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
  s.onload = () => {
    _chartJsLoaded = true;
    _chartJsCallbacks.forEach(fn => fn());
    _chartJsCallbacks = [];
  };
  document.head.appendChild(s);
}

