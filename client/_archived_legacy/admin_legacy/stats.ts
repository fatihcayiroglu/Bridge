// client/js/admin/stats.ts
// Admin paneli — İstatistik sekmesi (📊)

import { _adminCard, _statCard, _sectionTitle, _emptyState } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare const API: string;

export async function loadAdminStats(el: HTMLElement): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/admin/stats`);
    if (!r.ok) return void (el.innerHTML = `<div style="color:#e55;padding:20px;">Erişim reddedildi (${Number(r.status)})</div>`);
    const { totals, msgsByDay, topServers, topUsers } = await r.json();

    el.innerHTML = `
      ${_sectionTitle('📊 Genel İstatistikler')}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:28px;">
        ${_statCard('👥', 'Toplam Kullanıcı',  totals.totalUsers,    '#8892f8')}
        ${_statCard('🖥️', 'Toplam Sunucu',     totals.totalServers,  '#8892f8')}
        ${_statCard('💬', 'Toplam Mesaj',       totals.totalMessages, '#57f287')}
        ${_statCard('📨', 'Toplam DM',          totals.totalDMs,      '#57f287')}
        ${_statCard('🟢', 'Çevrimiçi',          totals.onlineUsers,   '#43b581')}
        ${_statCard('📧', 'E-posta Doğrulı',    totals.verifiedEmails,'#faa61a')}
        ${_statCard('🔐', '2FA Aktif',          totals.twoFaEnabled,  '#faa61a')}
        ${_statCard('🆕', 'Bu Hafta Kayıt',     totals.newUsers7d,    '#eb459e')}
      </div>
      <div style="margin-bottom:28px;">
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">📈 Son 7 Günlük Mesaj Trafiği</div>
          <canvas id="admin-msg-chart" height="120" style="width:100%;display:block;"></canvas>
        `)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">🏆 En Büyük Sunucular</div>
          ${topServers.length ? topServers.map((s: { name: string; memberCount: number }, i: number) => `
            <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e38;font-size:13px;">
              <span style="color:#bbb;">${i+1}. ${escHtml(s.name)}</span>
              <span style="color:#8892f8;font-weight:600;">${s.memberCount.toLocaleString('tr-TR')} üye</span>
            </div>`).join('') : _emptyState('Sunucu yok')}
        `)}
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">💬 En Aktif Kullanıcılar (30 gün)</div>
          ${topUsers.length ? topUsers.map((u: { displayName: string; msgCount: number }, i: number) => `
            <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e38;font-size:13px;">
              <span style="color:#bbb;">${i+1}. ${escHtml(u.displayName)}</span>
              <span style="color:#57f287;font-weight:600;">${u.msgCount.toLocaleString('tr-TR')} msg</span>
            </div>`).join('') : _emptyState('Veri yok')}
        `)}
      </div>`;

    requestAnimationFrame(() => _drawMsgChart(msgsByDay));
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

function _drawMsgChart(msgsByDay: { day: number; n: number }[]) {
  const canvas = document.getElementById('admin-msg-chart') as HTMLCanvasElement | null;
  if (!canvas || !msgsByDay?.length) return;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const dpr = window.devicePixelRatio || 1;
  const W   = Math.max(200, (canvas.parentElement as HTMLElement).clientWidth - 40);
  const H   = 120;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const vals = msgsByDay.map(d => d.n);
  const max  = Math.max(...vals, 1);
  const PAD  = { t: 10, b: 26, l: 10, r: 10 };
  const chartH = H - PAD.t - PAD.b;
  const step   = (W - PAD.l - PAD.r) / vals.length;
  const BAR    = Math.max(4, step - 4);

  ctx.strokeStyle = '#1e1e38';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = PAD.t + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
  });

  vals.forEach((v, i) => {
    const x  = PAD.l + i * step + (step - BAR) / 2;
    const bh = Math.max(2, (v / max) * chartH);
    const y  = PAD.t + chartH - bh;
    const g  = ctx.createLinearGradient(0, y, 0, y + bh);
    g.addColorStop(0, '#8892f8'); g.addColorStop(1, '#4a52c8');
    ctx.fillStyle = g;
    if ((ctx as CanvasRenderingContext2D & { roundRect?: Function }).roundRect) {
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D & { roundRect: Function }).roundRect(x, y, BAR, bh, [3, 3, 0, 0]);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, BAR, bh);
    }
  });

  ctx.fillStyle = '#555';
  ctx.font = `10px sans-serif`;
  ctx.textAlign = 'center';
  const today = Math.floor(Date.now() / 86400000);
  vals.forEach((_, i) => {
    const d = msgsByDay[i].day - today;
    const label = d === 0 ? 'Bugün' : d === -1 ? 'Dün' : `${d}g`;
    ctx.fillText(label, PAD.l + i * step + step / 2, H - 8);
  });
}
