// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AnalyticsDashboardPanel.svelte
//              client/js/core/analytics-dashboard-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/analytics-dashboard.ts — Sprint 94
// Sunucu Analitik Dashboard — üye büyüme grafiği, aktivite heatmap, retention
// Sunucu ayarları / analytics sekmesinden açılır.
// Chart.js (mevcut bağımlılık) kullanılır.

import { BridgeRegistry } from './bridge-registry.js';
import { apiFetch, escHtml } from './utils.js';

(function () {

  const API = (window as Record<string, string>).API_BASE || '';

  // Chart.js'i lazy yükle
  async function loadChart(): Promise<typeof import('chart.js') | null> {
    try {
      // @ts-ignore
      if (window.Chart) return window.Chart;
      return null;
    } catch { return null; }
  }

  // ── ANA DASHBOARD ─────────────────────────────────────────────────────────
  async function renderAnalyticsDashboard(
    serverId: string,
    container: HTMLElement,
    isAdmin = false,
  ): Promise<void> {
    container.innerHTML = `
      <div class="analytics-dashboard">
        <div class="analytics-header">
          <h3>📊 Topluluk Analitiği</h3>
          <div class="analytics-header-actions">
            <select id="analytics-range" class="settings-select" aria-label="Zaman aralığı">
              <option value="7">Son 7 Gün</option>
              <option value="30" selected>Son 30 Gün</option>
              <option value="90">Son 90 Gün</option>
            </select>
            ${isAdmin ? `<button id="analytics-export-csv" class="analytics-btn-secondary" title="CSV olarak dışa aktar">⬇ CSV</button>` : ''}
          </div>
        </div>
        ${!isAdmin ? `<div class="analytics-notice">ℹ️ Bu veriler tüm üyelere görünür. Yalnızca sunucu yöneticileri CSV ihracatına erişebilir.</div>` : ''}

        <!-- Özet kartlar -->
        <div class="analytics-cards" id="analytics-summary-cards">
          <div class="analytics-card skeleton"></div>
          <div class="analytics-card skeleton"></div>
          <div class="analytics-card skeleton"></div>
          <div class="analytics-card skeleton"></div>
        </div>

        <!-- Büyüme grafiği -->
        <div class="analytics-chart-wrap">
          <h4>Üye Büyümesi</h4>
          <canvas id="analytics-growth-chart" height="200"></canvas>
        </div>

        <!-- Mesaj aktivitesi -->
        <div class="analytics-chart-wrap">
          <h4>Günlük Mesaj Aktivitesi</h4>
          <canvas id="analytics-message-chart" height="160"></canvas>
        </div>

        <!-- Saat heatmap -->
        <div class="analytics-chart-wrap">
          <h4>Saatlik Aktivite Dağılımı <span id="analytics-tz-label" class="analytics-tz-badge"></span></h4>
          <div id="analytics-hour-heatmap" class="hour-heatmap"></div>
          <div class="heatmap-legend">
            <span>Az</span>
            <div class="heatmap-legend-bar"></div>
            <span>Çok</span>
          </div>
        </div>

        <!-- Haftalık dağılım -->
        <div class="analytics-chart-wrap">
          <h4>Haftanın En Aktif Günleri</h4>
          <div id="analytics-dow-bars" class="dow-bars"></div>
        </div>

        <!-- Kanal dağılımı -->
        <div class="analytics-chart-wrap">
          <h4>En Aktif Kanallar (30 Gün)</h4>
          <div id="analytics-channel-breakdown"></div>
        </div>

        <!-- Retention -->
        <div class="analytics-chart-wrap">
          <h4>Bağlılık (Retention)</h4>
          <div id="analytics-retention" class="retention-grid"></div>
        </div>

        <!-- En aktif kullanıcılar -->
        <div class="analytics-chart-wrap">
          <h4>En Aktif Üyeler (30 Gün)</h4>
          <div id="analytics-top-users"></div>
        </div>
      </div>
    `;

    // Timezone bilgisini göster
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzEl = document.getElementById('analytics-tz-label');
    if (tzEl) tzEl.textContent = `(${tzName})`;

    await _loadAll(serverId, 30);

    document.getElementById('analytics-range')?.addEventListener('change', (e) => {
      const days = parseInt((e.target as HTMLSelectElement).value, 10);
      _loadAll(serverId, days);
    });

    if (isAdmin) {
      document.getElementById('analytics-export-csv')?.addEventListener('click', () => {
        void _exportCsv(serverId);
      });
    }
  }

  // Sonraki CSV export için son yüklenen veriyi sakla
  let _lastSummary: Record<string, unknown> = {};
  let _lastGrowth:  Record<string, unknown> = {};

  async function _loadAll(serverId: string, days: number): Promise<void> {
    const [summary, growth, activity, retention] = await Promise.all([
      apiFetch(`${API}/api/v1/servers/${serverId}/stats`).then(r => r.json()),
      apiFetch(`${API}/api/v1/servers/${serverId}/stats/growth?days=${days}`).then(r => r.json()),
      apiFetch(`${API}/api/v1/servers/${serverId}/stats/activity`).then(r => r.json()),
      apiFetch(`${API}/api/v1/servers/${serverId}/stats/retention`).then(r => r.json()),
    ]);

    _lastSummary = summary;
    _lastGrowth  = growth;

    // summary.isOwner sunucu tarafından döner — CSV butonu buna göre gösterilir
    const isOwner = !!(summary as { isOwner?: boolean }).isOwner;
    const exportBtn = document.getElementById('analytics-export-csv') as HTMLButtonElement | null;
    if (exportBtn) exportBtn.style.display = isOwner ? '' : 'none';

    _renderSummaryCards(summary, retention);
    _renderGrowthChart(growth);
    _renderMessageChart(growth);
    _renderHourHeatmap(activity);
    _renderDowBars(activity);
    _renderChannelBreakdown(summary.channelBreakdown ?? []);
    _renderRetention(retention);
    _renderTopUsers(summary.topUsers ?? []);
  }

  // ── ÖZET KARTLAR ─────────────────────────────────────────────────────────
  function _renderSummaryCards(s: {
    memberCount: number; totalMessages: number; activeUsers7d: number; activeUsers30d: number;
  }, r: { dauRate: number; mauRate: number }): void {
    const el = document.getElementById('analytics-summary-cards');
    if (!el) return;
    el.innerHTML = `
      ${_card('👥', 'Toplam Üye',   s.memberCount.toLocaleString('tr-TR'))}
      ${_card('💬', 'Toplam Mesaj', s.totalMessages.toLocaleString('tr-TR'))}
      ${_card('🔥', 'Aktif (7g)',   s.activeUsers7d.toLocaleString('tr-TR'), `%${r.dauRate} günlük bağlılık`)}
      ${_card('📅', 'Aktif (30g)',  s.activeUsers30d.toLocaleString('tr-TR'), `%${r.mauRate} aylık bağlılık`)}
    `;
  }

  function _card(icon: string, label: string, value: string, sub = ''): string {
    return `
      <div class="analytics-card">
        <div class="analytics-card-icon">${icon}</div>
        <div class="analytics-card-body">
          <div class="analytics-card-value">${escHtml(value)}</div>
          <div class="analytics-card-label">${escHtml(label)}</div>
          ${sub ? `<div class="analytics-card-sub">${escHtml(sub)}</div>` : ''}
        </div>
      </div>`;
  }

  // ── BÜYÜME GRAFİĞİ (Chart.js line) ────────────────────────────────────────
  let _growthChart: { destroy(): void } | null = null;
  let _msgChart: { destroy(): void } | null = null;

  function _renderGrowthChart(data: {
    cumulativeSeries: Array<{ day: string; totalMembers: number }>;
  }): void {
    const canvas = document.getElementById('analytics-growth-chart') as HTMLCanvasElement | null;
    if (!canvas) return;
    // @ts-ignore
    const Chart = window.Chart;
    if (!Chart) { canvas.insertAdjacentHTML('afterend', '<p class="analytics-no-chart">Chart.js yüklenmedi.</p>'); return; }

    _growthChart?.destroy();
    _growthChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.cumulativeSeries.map(d => d.day.slice(5)),
        datasets: [{
          label: 'Toplam Üye',
          data:   data.cumulativeSeries.map(d => d.totalMembers),
          borderColor: 'var(--brand, #2d9cdb)',
          backgroundColor: 'rgba(45,156,219,0.1)',
          fill: true, tension: 0.4, pointRadius: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: false }, x: { ticks: { maxTicksLimit: 10 } } },
      },
    });
  }

  function _renderMessageChart(data: {
    messageSeries: Array<{ day: string; msgCount: number }>;
  }): void {
    const canvas = document.getElementById('analytics-message-chart') as HTMLCanvasElement | null;
    if (!canvas) return;
    // @ts-ignore
    const Chart = window.Chart;
    if (!Chart) return;

    _msgChart?.destroy();
    _msgChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.messageSeries.map(d => d.day.slice(5)),
        datasets: [{
          label: 'Mesaj',
          data:  data.messageSeries.map(d => d.msgCount),
          backgroundColor: 'rgba(87,242,135,0.7)',
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true }, x: { ticks: { maxTicksLimit: 10 } } },
      },
    });
  }

  // ── SAAT HEATMAP ──────────────────────────────────────────────────────────
  function _renderHourHeatmap(data: {
    hourlyDistribution: Array<{ hour: number; label: string; msgCount: number }>;
    peakHour: { label: string };
  }): void {
    const el = document.getElementById('analytics-hour-heatmap');
    if (!el) return;

    // Sunucu UTC saatleri döner; kullanıcının yerel UTC offset'ini uygula
    const tzOffsetHours = -new Date().getTimezoneOffset() / 60; // örn. UTC+3 → +3
    const shifted = data.hourlyDistribution.map(h => ({
      ...h,
      localHour: ((h.hour + tzOffsetHours) % 24 + 24) % 24,
    })).sort((a, b) => a.localHour - b.localHour);

    const max = Math.max(...shifted.map(h => h.msgCount), 1);
    el.innerHTML = shifted.map(h => {
      const intensity  = h.msgCount / max;
      const alpha      = 0.08 + intensity * 0.9;
      const hourLabel  = `${String(h.localHour).padStart(2, '0')}:00`;
      const cellLabel  = h.msgCount > 0 ? `${hourLabel}: ${h.msgCount} mesaj` : hourLabel;
      return `<div class="heatmap-cell" title="${cellLabel}"
        style="background:rgba(45,156,219,${alpha.toFixed(2)})"
        aria-label="${cellLabel}">
        <span class="heatmap-hour-label">${h.localHour}</span>
      </div>`;
    }).join('');

    // Peak saati de yerel saate çevir
    const peakLocalHour = ((parseInt(data.peakHour.label) + tzOffsetHours) % 24 + 24) % 24;
    const peakLabel = `${String(peakLocalHour).padStart(2, '0')}:00`;
    el.insertAdjacentHTML('afterend',
      `<p class="analytics-insight">⚡ En aktif saat: <strong>${peakLabel}</strong></p>`);
  }

  // ── HAFTANIN GÜNÜ ─────────────────────────────────────────────────────────
  function _renderDowBars(data: {
    weeklyDistribution: Array<{ label: string; msgCount: number }>;
    peakDay: { label: string };
  }): void {
    const el = document.getElementById('analytics-dow-bars');
    if (!el) return;

    const max = Math.max(...data.weeklyDistribution.map(d => d.msgCount), 1);
    el.innerHTML = data.weeklyDistribution.map(d => {
      const pct = Math.round((d.msgCount / max) * 100);
      return `
        <div class="dow-bar-row">
          <span class="dow-bar-label">${d.label.slice(0, 3)}</span>
          <div class="dow-bar-track">
            <div class="dow-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="dow-bar-count">${d.msgCount.toLocaleString('tr-TR')}</span>
        </div>`;
    }).join('');

    el.insertAdjacentHTML('afterend',
      `<p class="analytics-insight">📅 En aktif gün: <strong>${data.peakDay.label}</strong></p>`);
  }

  // ── RETENTION ─────────────────────────────────────────────────────────────
  function _renderRetention(r: {
    dau: number; wau: number; mau: number;
    dauRate: number; wauRate: number; mauRate: number; dauMauRatio: number;
  }): void {
    const el = document.getElementById('analytics-retention');
    if (!el) return;
    el.innerHTML = `
      ${_retCard('Günlük Aktif',  r.dau, r.dauRate, 'DAU')}
      ${_retCard('Haftalık Aktif', r.wau, r.wauRate, 'WAU')}
      ${_retCard('Aylık Aktif',    r.mau, r.mauRate, 'MAU')}
      <div class="retention-card retention-ratio">
        <div class="ret-metric">DAU/MAU</div>
        <div class="ret-value">${r.dauMauRatio}%</div>
        <div class="ret-desc">${_retHealth(r.dauMauRatio)}</div>
      </div>
    `;
  }

  function _retCard(label: string, count: number, rate: number, key: string): string {
    return `
      <div class="retention-card">
        <div class="ret-metric">${key}</div>
        <div class="ret-value">${count.toLocaleString('tr-TR')}</div>
        <div class="ret-rate">%${rate} üye</div>
        <div class="ret-label">${label}</div>
      </div>`;
  }

  function _retHealth(ratio: number): string {
    if (ratio >= 20) return '💚 Sağlıklı topluluk';
    if (ratio >= 10) return '🟡 Orta bağlılık';
    return '🔴 Düşük bağlılık';
  }

  // ── EN AKTİF KULLANICILAR ─────────────────────────────────────────────────
  function _renderTopUsers(users: Array<{ displayName: string; msgCount: number }>): void {
    const el = document.getElementById('analytics-top-users');
    if (!el) return;
    if (!users.length) { el.innerHTML = '<p class="analytics-empty">Veri yok.</p>'; return; }

    const max = users[0].msgCount || 1;
    el.innerHTML = `<div class="top-users-list">${users.map((u, i) => `
      <div class="top-user-row">
        <span class="top-user-rank">${i + 1}</span>
        <span class="top-user-name">${escHtml(u.displayName)}</span>
        <div class="top-user-bar-track">
          <div class="top-user-bar-fill" style="width:${Math.round(u.msgCount/max*100)}%"></div>
        </div>
        <span class="top-user-count">${u.msgCount.toLocaleString('tr-TR')}</span>
      </div>`).join('')}
    </div>`;
  }

  // ── KANAL DAĞILIMI ────────────────────────────────────────────────────────
  function _renderChannelBreakdown(channels: Array<{ channelName: string; msgCount: number }>): void {
    const el = document.getElementById('analytics-channel-breakdown');
    if (!el) return;
    if (!channels.length) {
      el.innerHTML = '<p class="analytics-empty">Veri yok.</p>';
      return;
    }

    const max = channels[0].msgCount || 1;
    el.innerHTML = `<div class="top-users-list">${channels.map((c, i) => `
      <div class="top-user-row">
        <span class="top-user-rank">${i + 1}</span>
        <span class="top-user-name">#${escHtml(c.channelName)}</span>
        <div class="top-user-bar-track">
          <div class="top-user-bar-fill" style="width:${Math.round(c.msgCount / max * 100)}%"></div>
        </div>
        <span class="top-user-count">${c.msgCount.toLocaleString('tr-TR')}</span>
      </div>`).join('')}
    </div>`;
  }

  // ── CSV EXPORT (admin only) ────────────────────────────────────────────────
  async function _exportCsv(serverId: string): Promise<void> {
    const btn = document.getElementById('analytics-export-csv') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Hazırlanıyor…'; }

    try {
      const rows: string[][] = [
        ['Metrik', 'Değer'],
        ['Toplam Üye',    String((_lastSummary as { memberCount?: number }).memberCount  ?? '')],
        ['Toplam Mesaj',  String((_lastSummary as { totalMessages?: number }).totalMessages ?? '')],
        ['Aktif (7g)',    String((_lastSummary as { activeUsers7d?: number }).activeUsers7d  ?? '')],
        ['Aktif (30g)',   String((_lastSummary as { activeUsers30d?: number }).activeUsers30d ?? '')],
        [],
        ['Gün', 'Yeni Üye', 'Mesaj Sayısı'],
      ];

      const joinSeries    = ((_lastGrowth as { joinSeries?: Array<{day: string; newMembers: number}> }).joinSeries    ?? []);
      const messageSeries = ((_lastGrowth as { messageSeries?: Array<{day: string; msgCount: number}> }).messageSeries ?? []);
      const msgMap        = Object.fromEntries(messageSeries.map(m => [m.day, m.msgCount]));

      for (const j of joinSeries) {
        rows.push([j.day, String(j.newMembers), String(msgMap[j.day] ?? 0)]);
      }

      rows.push([], ['Kanal', 'Mesaj Sayısı']);
      for (const c of ((_lastSummary as { channelBreakdown?: Array<{channelName:string; msgCount:number}> }).channelBreakdown ?? [])) {
        rows.push([c.channelName, String(c.msgCount)]);
      }

      rows.push([], ['Kullanıcı', 'Mesaj Sayısı (30g)']);
      for (const u of ((_lastSummary as { topUsers?: Array<{displayName:string; msgCount:number}> }).topUsers ?? [])) {
        rows.push([u.displayName, String(u.msgCount)]);
      }

      const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `bridge-analytics-${serverId}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ CSV'; }
    }
  }

  BridgeRegistry.register('renderAnalyticsDashboard', (sid: unknown, el: unknown, isAdmin: unknown) =>
    renderAnalyticsDashboard(sid as string, el as HTMLElement, isAdmin as boolean | undefined));

})();
