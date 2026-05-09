// client/js/core/activity.js Aktivite & Durum Sistemi
// Bridge'de herkese ücretsiz

'use strict';
import { getMe } from './globals.js';

const ACTIVITY_ICONS = {
  playing:   '🎮',
  listening: '🎵',
  watching:  '📺',
  streaming: '🔴',
  coding:    '💻',
  reading:   '📚',
  custom:    '✏️',
};

const ACTIVITY_LABELS = {
  playing:   'Oynuyor',
  listening: 'Dinliyor',
  watching:  'İzliyor',
  streaming: 'Yayın yapıyor',
  coding:    'Kod yazıyor',
  reading:   'Okuyor',
  custom:    'Özel durum',
};

// ── Aktivite formatla ──────────────────────────────────────
function formatActivity(activity) {
  if (!activity) return null;
  const icon  = ACTIVITY_ICONS[activity.type] || '✏️';
  const label = ACTIVITY_LABELS[activity.type] || activity.type;
  const name  = activity.name || '';
  const detail = activity.detail || '';

  return {
    icon,
    label,
    name,
    detail,
    displayText: name ? `${label}: ${name}` : label,
    fullText: detail ? `${name} — ${detail}` : name,
  };
}

// ── Aktivite rozeti HTML ───────────────────────────────────
function renderActivityBadge(activity) {
  if (!activity) return '';
  const fmt = formatActivity(activity);
  return `<span class="activity-badge" title="${escHtml(fmt.fullText || fmt.displayText)}">
    ${fmt.icon} <span class="activity-name">${escHtml(fmt.displayText.slice(0, 40))}</span>
  </span>`;
}

// ── Aktivite Ayar Modalı ───────────────────────────────────
function openActivityModal() {
  const existing = document.getElementById('activity-modal');
  if (existing) { existing.remove(); return; }

  const currentActivity = getMe()?.activity;

  const modal = document.createElement('div');
  modal.id = 'activity-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:95%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 style="margin:0;">🎯 Aktivite Durumu</h2>
        <button class="icon-btn" onclick="document.getElementById('activity-modal').remove()">✕</button>
      </div>

      ${currentActivity ? `
        <div style="background:var(--brand-subtle);border:1px solid var(--brand);border-radius:8px;padding:12px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:20px;">${ACTIVITY_ICONS[currentActivity.type] || '✏️'}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${escHtml(currentActivity.name || ACTIVITY_LABELS[currentActivity.type] || '')}</div>
              ${currentActivity.detail ? `<div style="font-size:12px;color:var(--text-muted);">${escHtml(currentActivity.detail)}</div>` : ''}
            </div>
          </div>
          <button class="btn" style="font-size:12px;padding:4px 10px;background:var(--red);" onclick="clearActivity()">Temizle</button>
        </div>
      ` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
        ${Object.entries(ACTIVITY_TYPES_CLIENT).map(([type, { icon, label }]) => `
          <button class="activity-type-btn ${currentActivity?.type === type ? 'active' : ''}" 
                  data-type="${type}"
                  onclick="selectActivityType('${type}')">
            <span style="font-size:20px;">${icon}</span>
            <span style="font-size:13px;">${label}</span>
          </button>
        `).join('')}
      </div>

      <div id="activity-form" style="display:${currentActivity ? 'block' : 'none'};">
        <label class="settings-label">Ne yapıyorsunuz?</label>
        <input id="activity-name" class="input" style="width:100%;margin-bottom:10px;"
               placeholder="örn: Minecraft, Spotify, YouTube"
               value="${escHtml(currentActivity?.name || '')}" maxlength="64">

        <label class="settings-label">Detay (isteğe bağlı)</label>
        <input id="activity-detail" class="input" style="width:100%;margin-bottom:16px;"
               placeholder="örn: Creative mode, Lo-fi playlist"
               value="${escHtml(currentActivity?.detail || '')}" maxlength="128">

        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('activity-modal').remove()">İptal</button>
          <button class="btn" onclick="saveActivity()">✅ Kaydet</button>
        </div>
      </div>

      ${!currentActivity ? `
        <p style="color:var(--text-muted);font-size:13px;text-align:center;">
          Bir aktivite tipi seçin 👆
        </p>` : ''}
    </div>`;

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

const ACTIVITY_TYPES_CLIENT = {
  playing:   { icon: '🎮', label: 'Oynuyor' },
  listening: { icon: '🎵', label: 'Dinliyor' },
  watching:  { icon: '📺', label: 'İzliyor' },
  streaming: { icon: '🔴', label: 'Yayın' },
  coding:    { icon: '💻', label: 'Kodluyor' },
  reading:   { icon: '📚', label: 'Okuyor' },
  custom:    { icon: '✏️', label: 'Özel' },
};

let _selectedActivityType = null;

function selectActivityType(type) {
  _selectedActivityType = type;
  document.querySelectorAll('.activity-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  const form = document.getElementById('activity-form');
  if (form) form.style.display = 'block';

  // Placeholder güncelle
  const nameInput = document.getElementById('activity-name');
  if (nameInput) {
    const examples = {
      playing:   'örn: Minecraft, Valorant, Steam',
      listening: 'örn: Spotify, YouTube Music',
      watching:  'örn: Netflix, YouTube',
      streaming: 'örn: Twitch kanalım',
      coding:    'örn: Bridge projesi, React app',
      reading:   'örn: Dune, Medium makalesi',
      custom:    'Ne yapıyorsunuz?',
    };
    nameInput.placeholder = examples[type] || 'Ne yapıyorsunuz?';
    nameInput.focus();
  }
}

async function saveActivity() {
  const type   = _selectedActivityType || (getMe()?.activity?.type) || 'custom';
  const name   = document.getElementById('activity-name')?.value.trim();
  const detail = document.getElementById('activity-detail')?.value.trim();

  if (!name) return toast('Ne yaptığınızı yazın', 'error');

  try {
    const r = await apiFetch(`${API}/api/activity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name, detail }),
    });
    const data = await r.json();

    if (!r.ok) return toast(data.error || 'Kaydedilemedi', 'error');

    if (getMe()) getMe().activity = data.activity;
    document.getElementById('activity-modal')?.remove();
    toast(`${ACTIVITY_ICONS[type]} Aktivite güncellendi!`, 'success');
    updateActivityDisplay();
  } catch {
    toast('Bağlantı hatası', 'error');
  }
}

async function clearActivity() {
  try {
    await apiFetch(`${API}/api/activity`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (getMe()) getMe().activity = null;
    document.getElementById('activity-modal')?.remove();
    toast('Aktivite temizlendi', 'info');
    updateActivityDisplay();
  } catch {
    toast('Hata', 'error');
  }
}

function updateActivityDisplay() {
  // Kendi profilindeki aktivite badge'ini güncelle
  const badge = document.getElementById('my-activity-badge');
  if (badge) {
    const activity = getMe()?.activity;
    badge.innerHTML = activity ? renderActivityBadge(activity) : '';
    badge.style.display = activity ? '' : 'none';
  }
}

// ── Socket handler: başkalarının aktivitesini al ───────────
function handleUserActivity(data) {
  const { userId, activity } = data;

  // Üye listesinde güncelle
  const memberRows = document.querySelectorAll(`.member-row[data-uid="${userId}"]`);
  memberRows.forEach(row => {
    const existingBadge = row.querySelector('.activity-badge');
    if (existingBadge) existingBadge.remove();
    if (activity) {
      const nameEl = row.querySelector('.member-name');
      if (nameEl) nameEl.insertAdjacentHTML('afterend', renderActivityBadge(activity));
    }
  });
}

// CSS
const activityStyle = document.createElement('style');
activityStyle.textContent = `
  .activity-type-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    color: var(--text-normal);
    transition: all 0.15s;
  }
  .activity-type-btn:hover {
    background: var(--bg-hover);
    border-color: var(--brand);
  }
  .activity-type-btn.active {
    background: var(--brand-subtle);
    border-color: var(--brand);
    color: var(--brand);
  }
  .activity-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-3);
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
    max-width: 150px;
    overflow: hidden;
  }
  .activity-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
document.head.appendChild(activityStyle);

export {
  clearActivity,
  formatActivity,
  handleUserActivity,
  openActivityModal,
  renderActivityBadge,
  saveActivity,
  selectActivityType,
  updateActivityDisplay,
};

