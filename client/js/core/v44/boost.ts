// client/js/core/v44/boost.js
// ModÃ¼l: Server Boost UI â€” boost satÄ±n alma + seviye gÃ¶stergesi
'use strict';

const BOOST_TIERS = [
  { level: 0, label: 'BaÅŸlangÄ±Ã§',  boosts: 0,  perks: ['Temel Ã¶zellikler'] },
  { level: 1, label: 'Seviye 1',   boosts: 2,  perks: ['Ã–zel emoji (+50)', 'HD ses kalitesi', 'Ã–zel davet arka planÄ±'] },
  { level: 2, label: 'Seviye 2',   boosts: 7,  perks: ['Ã–zel emoji (+100)', '256 kbps ses', 'Server banner', '50 MB dosya'] },
  { level: 3, label: 'Seviye 3',   boosts: 14, perks: ['Ã–zel emoji (+250)', '384 kbps ses', 'Vanity URL', '100 MB dosya', 'Animasyonlu icon'] },
];

async function openBoostPanel(serverId: string): Promise<void> {
  interface Booster { displayName?: string; username?: string; boostedAt?: string; }
  let boost: { count: number; boosters: Booster[] } = { count: 0, boosters: [] };
  try {
    const r = await apiFetch(`${API}/api/servers/${serverId}/boosts`);
    if (r.ok) boost = await r.json();
  } catch {}

  const tier    = BOOST_TIERS.slice().reverse().find(t => boost.count >= t.boosts) || BOOST_TIERS[0];
  const nextTier = BOOST_TIERS.find(t => t.boosts > boost.count);
  const progress = nextTier
    ? Math.round(((boost.count - tier.boosts) / (nextTier.boosts - tier.boosts)) * 100)
    : 100;

  const modal = document.createElement('div');
  modal.id = 'boost-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card boost-card" style="max-width:500px;width:95%;max-height:88vh;overflow-y:auto;">
      <div class="boost-header">
        <div style="font-size:36px;margin-bottom:8px;">ğŸš€</div>
        <h2 style="margin:0 0 4px">Server Boost</h2>
        <div style="color:var(--text-muted);font-size:13px;">${boost.count} aktif boost</div>
      </div>

      <div class="boost-tier-badge tier-${tier.level}">
        ${tier.label}
      </div>

      ${nextTier ? `
        <div class="boost-progress-wrap">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px;">
            <span>${tier.label}</span><span>${nextTier.label} (${nextTier.boosts} boost)</span>
          </div>
          <div class="boost-progress-bar">
            <div class="boost-progress-fill" style="width:${progress}%"></div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center;">
            ${nextTier.boosts - boost.count} boost daha gerekiyor
          </div>
        </div>` : `<div style="text-align:center;color:var(--success);font-size:13px;margin:12px 0;">âœ… Maksimum seviyeye ulaÅŸÄ±ldÄ±!</div>`}

      <div class="boost-perks">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;">âœ¨ Mevcut AyrÄ±calÄ±klar</div>
        ${tier.perks.map(p => `<div class="boost-perk-item">âœ… ${p}</div>`).join('')}
        ${nextTier ? `
          <div style="font-weight:600;font-size:13px;margin:12px 0 8px;color:var(--text-muted);">ğŸ”’ ${nextTier.label} AyrÄ±calÄ±klarÄ±</div>
          ${nextTier.perks.filter(p => !tier.perks.includes(p)).map(p => `<div class="boost-perk-item locked">ğŸ”’ ${p}</div>`).join('')}
        ` : ''}
      </div>

      <button class="btn btn-primary boost-btn" onclick="sendBoost('${serverId}')">
        ğŸš€ Bu Sunucuyu Boost'la
      </button>

      ${boost.boosters?.length ? `
        <div style="margin-top:16px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;">ğŸ’œ Boost'Ã§ular (${boost.boosters.length})</div>
          <div class="boost-boosters-list">
            ${boost.boosters.slice(0, 10).map(b => `
              <div class="boost-booster-item">
                <span style="font-size:16px;">ğŸ’œ</span>
                <span style="font-size:13px;">${escHtml(b.displayName || b.username)}</span>
                <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${_relBoostTime(b.boostedAt)}</span>
              </div>`).join('')}
            ${boost.boosters.length > 10 ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:6px;">+${boost.boosters.length - 10} kiÅŸi daha</div>` : ''}
          </div>
        </div>` : ''}

      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn" onclick="document.getElementById('boost-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function sendBoost(serverId: string): Promise<void> {
  const r = await apiFetch(`${API}/api/servers/${serverId}/boosts`, { method: 'POST' });
  const d = await r.json();
  if (!r.ok) return toast(d.error || 'Boost baÅŸarÄ±sÄ±z', 'error');
  toast('ğŸš€ Sunucu boost\'landÄ±! TeÅŸekkÃ¼rler!', 'success');
  document.getElementById('boost-modal')?.remove();
  setTimeout(() => openBoostPanel(serverId), 300);
}

function _relBoostTime(ts: string | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 86400000)  return 'bugÃ¼n';
  if (diff < 604800000) return `${Math.floor(diff/86400000)}g Ã¶nce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}

// Boost seviye barÄ±nÄ± header'a ekle
function injectBoostBar() {
  const header = document.querySelector('.server-header-content, .server-name-wrap');
  if (!header || document.getElementById('boost-mini-bar')) return;
  const sid = window.currentServer?._id as string | undefined;
  if (!sid) return;

  const bar = document.createElement('div');
  bar.id = 'boost-mini-bar';
  bar.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';
  bar.title = 'Server Boost';
  bar.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">ğŸš€</span><div class="boost-mini-fill" id="boost-mini-fill"></div>`;
  bar.onclick = () => openBoostPanel(sid);
  header.appendChild(bar);

  apiFetch(`${API}/api/servers/${sid}/boosts`).then(async r => {
    if (!r.ok) return;
    const { count } = await r.json();
    const fill = document.getElementById('boost-mini-fill');
    if (!fill) return;
    const maxBoosts = 14;
    const pct = Math.min(100, (count / maxBoosts) * 100);
    fill.style.cssText = `height:4px;border-radius:2px;background:var(--bg-secondary);width:60px;overflow:hidden;`;
    fill.innerHTML = `<div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#a37dff,#ff73c5);border-radius:2px;transition:.4s;"></div>`;
  }).catch(() => {});
}

document.addEventListener('bridge:server-selected', injectBoostBar);
setTimeout(injectBoostBar, 1000);

// Expose globals
window.openBoostPanel = openBoostPanel;
window.sendBoost      = sendBoost;

