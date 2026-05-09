// client/js/core/v41/onboarding.js
// Modül: Server Onboarding Wizard
'use strict';

async function openOnboardingSettings() {
  if (!currentServer) return;

  let config = { enabled: false, rulesChannelId: '', welcomeChannelId: '', welcomeMessage: 'Sunucuya hoş geldin, {user}! 👋', questions: [], channels: [] };
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/onboarding`);
    if (r.ok) config = await r.json();
  } catch {}

  const channels = config.channels || [];

  const modal = document.createElement('div');
  modal.id = 'onboarding-settings-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1100;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:540px;width:95%;max-height:88vh;overflow-y:auto;">
      <h2 style="margin-bottom:4px;">🚀 Onboarding Ayarları</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
        Yeni üyeler sunucuya katıldığında karşılama wizard'ı gösterilir.
      </p>

      <div class="form-group">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="ob-enabled" ${config.enabled ? 'checked' : ''}>
          <span>Onboarding'i etkinleştir</span>
        </label>
      </div>

      <div class="form-group">
        <label>Kurallar Kanalı <span style="font-size:11px;color:var(--text-muted);">(wizard'da gösterilir)</span></label>
        <select id="ob-rules-channel" class="input-field">
          <option value="">— Seçme —</option>
          ${channels.map(c => `<option value="${escHtml(c._id)}" ${config.rulesChannelId === c._id ? 'selected' : ''}>#${escHtml(c.name)}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>Karşılama Kanalı <span style="font-size:11px;color:var(--text-muted);">(hoş geldin mesajı burada gönderilir)</span></label>
        <select id="ob-welcome-channel" class="input-field">
          <option value="">— Seçme —</option>
          ${channels.map(c => `<option value="${escHtml(c._id)}" ${config.welcomeChannelId === c._id ? 'selected' : ''}>#${escHtml(c.name)}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>Hoş Geldin Mesajı</label>
        <textarea id="ob-welcome-msg" class="bio-textarea" maxlength="500" rows="3"
          placeholder="Sunucuya hoş geldin, {user}! 👋">${escHtml(config.welcomeMessage || '')}</textarea>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          <code>{user}</code> → üye adı, <code>{server}</code> → sunucu adı
        </div>
      </div>

      <div class="form-group">
        <label>Sorular <span style="font-size:11px;color:var(--text-muted);">(max 5 — wizard'da gösterilir)</span></label>
        <div id="ob-questions-list">
          ${(config.questions || []).map((q, i) => `
            <div style="display:flex;gap:6px;margin-bottom:6px;" id="ob-q-${i}">
              <input type="text" class="input-field ob-question" value="${escHtml(q.text || q)}" placeholder="Soru ${i+1}" style="flex:1;">
              <button class="btn" style="font-size:11px;padding:4px 8px;color:var(--danger);" onclick="removeOnboardingQuestion(${i})">✕</button>
            </div>`).join('')}
        </div>
        <button class="btn" style="font-size:12px;margin-top:6px;" onclick="addOnboardingQuestion()">+ Soru Ekle</button>
      </div>

      <div class="modal-footer" style="margin-top:20px;">
        <button class="btn btn-primary" onclick="saveOnboardingSettings()">💾 Kaydet</button>
        <button class="btn" onclick="document.getElementById('onboarding-settings-modal').remove()">İptal</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function addOnboardingQuestion() {
  const list = document.getElementById('ob-questions-list');
  if (!list) return;
  const existing = list.querySelectorAll('.ob-question').length;
  if (existing >= 5) return toast('Maksimum 5 soru ekleyebilirsin', 'error');
  const i = existing;
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';
  div.id = `ob-q-${i}`;
  div.innerHTML = `
    <input type="text" class="input-field ob-question" placeholder="Soru ${i+1}" style="flex:1;">
    <button class="btn" style="font-size:11px;padding:4px 8px;color:var(--danger);" onclick="this.parentElement.remove()">✕</button>`;
  list.appendChild(div);
}

function removeOnboardingQuestion(i) {
  document.getElementById(`ob-q-${i}`)?.remove();
}

async function saveOnboardingSettings() {
  if (!currentServer) return;
  const enabled = document.getElementById('ob-enabled')?.checked;
  const rulesChannelId = document.getElementById('ob-rules-channel')?.value;
  const welcomeChannelId = document.getElementById('ob-welcome-channel')?.value;
  const welcomeMessage = document.getElementById('ob-welcome-msg')?.value.trim();
  const questions = [...document.querySelectorAll('.ob-question')]
    .map(el => el.value.trim()).filter(Boolean)
    .map(text => ({ text }));

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/onboarding`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, rulesChannelId, welcomeChannelId, welcomeMessage, questions }),
  });
  if (!r.ok) { const d = await r.json(); return toast(d.error || 'Hata', 'error'); }
  toast('Onboarding ayarları kaydedildi ✅', 'success');
  document.getElementById('onboarding-settings-modal')?.remove();
}

// ── Onboarding Wizard (yeni üye için) ────────────────────────────────────────

async function checkAndShowOnboarding(serverId) {
  try {
    const r = await apiFetch(`${API}/api/servers/${serverId}/onboarding/status`);
    if (!r.ok) return;
    const data = await r.json();
    if (!data.required || data.completed) return;
    showOnboardingWizard(serverId, data.config);
  } catch {}
}

function showOnboardingWizard(serverId, config) {
  if (document.getElementById('onboarding-wizard-modal')) return;

  const questions = config.questions || [];
  let step = 0;
  const answers = {};

  const steps = [
    { id: 'welcome', title: '👋 Hoş Geldin!', content: buildWelcomeStep(config) },
    ...(config.rulesChannelId ? [{ id: 'rules', title: '📜 Kurallar', content: buildRulesStep(config) }] : []),
    ...questions.map((q, i) => ({ id: `q${i}`, title: `❓ Soru ${i+1}`, content: buildQuestionStep(q, i) })),
    { id: 'done', title: '🎉 Tamamlandı!', content: buildDoneStep() },
  ];

  const modal = document.createElement('div');
  modal.id = 'onboarding-wizard-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1200;';

  function render() {
    const s = steps[step];
    const isLast = step === steps.length - 1;
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;text-align:center;">
        <div style="display:flex;justify-content:center;gap:6px;margin-bottom:20px;">
          ${steps.map((_, i) => `<div style="width:${i === step ? 24 : 8}px;height:8px;border-radius:4px;
            background:${i === step ? 'var(--brand)' : i < step ? 'var(--success)' : 'var(--border)'};
            transition:.3s;"></div>`).join('')}
        </div>
        <h2 style="margin-bottom:12px;">${s.title}</h2>
        <div id="ob-step-content" style="margin-bottom:24px;">${s.content}</div>
        <div style="display:flex;gap:8px;justify-content:center;">
          ${step > 0 && !isLast ? `<button class="btn" onclick="obPrev()">← Geri</button>` : ''}
          ${isLast
            ? `<button class="btn btn-primary" onclick="completeOnboarding('${serverId}')">🎉 Başla!</button>`
            : `<button class="btn btn-primary" onclick="obNext()">Devam → </button>`}
        </div>
      </div>`;
  }

  window.obNext = () => { collectAnswer(steps[step], answers); step = Math.min(step+1, steps.length-1); render(); };
  window.obPrev = () => { step = Math.max(step-1, 0); render(); };

  document.body.appendChild(modal);
  render();
}

function collectAnswer(step, answers) {
  if (step.id.startsWith('q')) {
    const input = document.querySelector('#ob-step-content input, #ob-step-content textarea');
    if (input) answers[step.id] = input.value;
  }
}

function buildWelcomeStep(config) {
  return `
    <div style="font-size:48px;margin-bottom:12px;">🎉</div>
    <p style="color:var(--text-muted);line-height:1.6;">
      Bu sunucuya hoş geldin! Devam etmeden önce birkaç adımdan geçmeni istiyoruz.
    </p>`;
}

function buildRulesStep(config) {
  return `
    <p style="color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
      Sunucumuza katılmadan önce kurallarımızı okumanı ve kabul etmeni istiyoruz.
    </p>
    <label style="display:flex;align-items:flex-start;gap:8px;text-align:left;cursor:pointer;margin:0 auto;max-width:300px;">
      <input type="checkbox" id="ob-rules-agree" style="margin-top:2px;flex-shrink:0;">
      <span style="font-size:13px;">Sunucu kurallarını okudum ve kabul ediyorum.</span>
    </label>`;
}

function buildQuestionStep(q, i) {
  return `
    <p style="color:var(--text-muted);margin-bottom:12px;">${escHtml(q.text || q)}</p>
    <textarea class="bio-textarea" rows="3" style="text-align:left;" placeholder="Cevabını buraya yaz…"></textarea>`;
}

function buildDoneStep() {
  return `
    <div style="font-size:56px;margin-bottom:12px;">🚀</div>
    <p style="color:var(--text-muted);line-height:1.6;">
      Harika! Artık sunucuya tam erişimin var. İyi eğlenceler!
    </p>`;
}

async function completeOnboarding(serverId) {
  try {
    await apiFetch(`${API}/api/servers/${serverId}/onboarding/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    });
  } catch {}
  document.getElementById('onboarding-wizard-modal')?.remove();
  toast('Onboarding tamamlandı! 🎉', 'success');
}

// Expose globals
