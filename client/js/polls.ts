import { BridgeRegistry } from './core/bridge-registry.ts';

import { createLogger } from './core/logger.ts';
const log = createLogger('Polls');

// client/js/polls.ts Native Poll System
// Usage: openPollCreator() from message toolbar, renderPollMessage() for display

let _pollCreatorChannelId = null;

// ── OPEN POLL CREATOR MODAL ───────────────────────────────────
function openPollCreator() {
  if (!currentChannel) return toast('Önce bir kanal seç', 'error');
  _pollCreatorChannelId = currentChannel._id;

  const existing = document.getElementById('poll-creator-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'poll-creator-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;">
      <h2 style="margin-bottom:4px;">ğŸ“Š Anket Oluştur</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">Tüm üyeler oy verebilir — bedava âœ¦</p>

      <label class="settings-label">Soru</label>
      <input id="poll-question" class="input" placeholder="Ne sormak istiyorsun?" maxlength="300"
             style="width:100%;margin-bottom:16px;" />

      <label class="settings-label">Seçenekler <span style="color:var(--text-muted);font-size:12px;">(en az 2, en fazla 10)</span></label>
      <div id="poll-options-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        <div class="poll-opt-row"><input class="input poll-opt-input" placeholder="Seçenek 1" maxlength="100" style="width:100%;"/></div>
        <div class="poll-opt-row"><input class="input poll-opt-input" placeholder="Seçenek 2" maxlength="100" style="width:100%;"/></div>
      </div>
      <button class="btn btn-secondary" onclick="addPollOption()" style="margin-bottom:16px;font-size:13px;">+ Seçenek Ekle</button>

      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="poll-multi" style="width:16px;height:16px;accent-color:var(--brand);">
          Çoklu seçim
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <span>Süre:</span>
          <select id="poll-duration" class="input" style="padding:4px 8px;font-size:13px;">
            <option value="">Sınırsız</option>
            <option value="60">1 saat</option>
            <option value="360">6 saat</option>
            <option value="1440">24 saat</option>
            <option value="4320">3 gün</option>
            <option value="10080">7 gün</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="poll-vote-change" style="width:16px;height:16px;accent-color:var(--brand);">
          Oy değiştirilebilir
        </label>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('poll-creator-modal').remove()">İptal</button>
        <button class="btn" onclick="submitPoll()">ğŸ“Š Anketi Gönder</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  document.getElementById('poll-question')?.focus();
}

function addPollOption() {
  const list = document.getElementById('poll-options-list');
  if (!list) return;
  const count = list.querySelectorAll('.poll-opt-input').length;
  if (count >= 10) return toast('Maksimum 10 seçenek', 'error');
  const row = document.createElement('div');
  row.className = 'poll-opt-row';
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.innerHTML = `
    <input class="input poll-opt-input" placeholder="Seçenek ${count + 1}" maxlength="100" style="flex:1;"/>
    <button class="btn btn-secondary" onclick="this.parentElement.remove()" style="padding:6px 10px;">✕</button>`;
  list.appendChild(row);
}

async function submitPoll() {
  const question = document.getElementById('poll-question')?.value.trim();
  if (!question) return toast('Soru gerekli', 'error');

  const optInputs = document.querySelectorAll('#poll-options-list .poll-opt-input');
  const options   = Array.from(optInputs).map(i => i.value.trim()).filter(Boolean);
  if (options.length < 2) return toast('En az 2 seçenek gerekli', 'error');

  const multiSelect = document.getElementById('poll-multi')?.checked || false;
  const durationVal = document.getElementById('poll-duration')?.value;
  const duration    = durationVal ? parseInt(durationVal) : null;

  try {
    const r = await apiFetch(`${API}/api/channels/${_pollCreatorChannelId}/polls`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, options, multiSelect, duration, allowVoteChange: document.getElementById('poll-vote-change')?.checked || false }),
    });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Anket oluşturulamadı', 'error'); }
    const poll = await r.json();

    // Emit as socket message so everyone sees it
    socket.emit('poll:created', { channelId: _pollCreatorChannelId, poll });
    document.getElementById('poll-creator-modal')?.remove();
    toast('Anket oluşturuldu!', 'success');
  } catch (e) {
    log.error(e);
    toast('Anket oluşturulamadı', 'error');
  }
}

// ── RENDER POLL INSIDE A MESSAGE ──────────────────────────────
function renderPollBlock(poll, currentUserId) {
  if (!poll || !poll.options) return '';

  const totalVotes = poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
  const expired    = poll.expiresAt && Date.now() > poll.expiresAt;
  const closed     = poll.closed || expired;

  const userVotes = poll.options.filter(o => (o.votes || []).includes(currentUserId)).map(o => o.id);

  let timeLabel = '';
  if (poll.expiresAt && !closed) {
    const rem = poll.expiresAt - Date.now();
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    timeLabel = `<span style="color:var(--text-muted);font-size:12px;">â± ${h}s ${m}d kaldı</span>`;
  } else if (closed) {
    timeLabel = `<span style="color:var(--text-muted);font-size:12px;">ğŸ”’ Anket kapandı</span>`;
  }

  const optionsHtml = poll.options.map(opt => {
    const votes   = opt.votes?.length || 0;
    const pct     = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
    const voted   = userVotes.includes(opt.id);
    const leading = opt.votes?.length === Math.max(...poll.options.map(o => o.votes?.length || 0)) && totalVotes > 0;

    return `<div class="poll-option ${voted ? 'poll-voted' : ''} ${closed ? 'poll-closed' : ''}"
                 onclick="${closed ? '' : `castPollVote('${poll._id}', '${opt.id}', ${poll.multiSelect})`}"
                 style="cursor:${closed ? 'default' : 'pointer'}">
      <div class="poll-opt-bar" style="width:${pct}%;background:${leading && closed ? 'var(--brand)' : 'var(--brand-alpha)'};"></div>
      <div class="poll-opt-content">
        <span class="poll-opt-text">${escHtml(opt.text)} ${voted ? '✓' : ''}</span>
        <span class="poll-opt-pct">${pct}% <span style="color:var(--text-muted);font-size:11px;">(${votes})</span></span>
      </div>
    </div>`;
  }).join('');

  const closeBtn = !closed && poll.createdBy === currentUserId
    ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="closePoll('${poll._id}')">Anketi Kapat</button>`
    : '';

  const editBtn = !closed && poll.createdBy === currentUserId
    ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="openPollEditor('${poll._id}')">✏️ Düzenle</button>`
    : '';

  const deleteBtn = poll.createdBy === currentUserId
    ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:var(--red);" onclick="deletePoll('${poll._id}')">🗑️</button>`
    : '';

  const unvoteBtn = !closed && poll.allowVoteChange && userVotes.length > 0
    ? `<button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="unvotePoll('${poll._id}')">↩️ Oyu Geri Al</button>`
    : '';

  return `<div class="poll-block" data-poll-id="${poll._id}">
    <div class="poll-header">
      <span class="poll-icon">ğŸ“Š</span>
      <div>
        <div class="poll-question">${escHtml(poll.question)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:2px;">
          ${totalVotes} oy • ${poll.multiSelect ? 'Çoklu seçim' : 'Tek seçim'}
          ${timeLabel ? '• ' + timeLabel : ''}
        </div>
      </div>
    </div>
    <div class="poll-options">${optionsHtml}</div>
    ${closeBtn ? `<div style="margin-top:8px;">${closeBtn}</div>` : ''}
  </div>`;
}

async function castPollVote(pollId, optionId, multiSelect) {
  // Toggle logic for multi-select: read current voted state from DOM
  const block = document.querySelector(`[data-poll-id="${pollId}"]`);
  if (!block) return;

  let optionIds = [optionId];
  if (multiSelect) {
    // Collect currently checked options + toggle this one
    const currentVoted = Array.from(block.querySelectorAll('.poll-voted'))
      .map(el => el.dataset.optId)
      .filter(Boolean);
    if (currentVoted.includes(optionId)) {
      optionIds = currentVoted.filter(id => id !== optionId);
    } else {
      optionIds = [...currentVoted, optionId];
    }
  }

  try {
    const r = await apiFetch(`${API}/api/polls/${pollId}/vote`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ optionIds }),
    });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Oy verilemedi', 'error'); }
    const updated = await r.json();
    // Re-render poll block in place
    const currentUserId = (BridgeRegistry.get('getCurrentUser') as (() => { _id: string } | null) | null)?.()?._id;
    const newHtml = renderPollBlock(updated, currentUserId);
    block.outerHTML = newHtml;
  } catch(e) {
    log.error(e);
    toast('Oy verilemedi', 'error');
  }
}

async function closePoll(pollId) {
  if (!confirm('Anketi kapatmak istediğine emin misin?')) return;
  try {
    await apiFetch(`${API}/api/polls/${pollId}/close`, { method: 'POST' });
    toast('Anket kapatıldı', 'success');
    // Re-fetch and re-render all polls in channel (simplest approach: reload messages)
    BridgeRegistry.call('loadMessages', currentChannel?._id);
  } catch(e) {
    toast('Anket kapatılamadı', 'error');
  }
}

// Socket: incoming poll from another user
function initPollSocket(socket) {
  socket.on('poll:created', ({ channelId, poll }) => {
    if (channelId !== currentChannel?._id) return;
    const feed = document.getElementById('messages');
    if (!feed) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-group poll-msg-group';
    wrapper.dataset.pollId = poll._id;
    wrapper.innerHTML = renderPollBlock(poll, (BridgeRegistry.get('getCurrentUser') as (() => { _id: string } | null) | null)?.()?._id);
    feed.appendChild(wrapper);
    feed.scrollTop = feed.scrollHeight;
  });

  socket.on('poll:updated', ({ poll }) => {
    const block = document.querySelector(`[data-poll-id="${poll._id}"]`);
    if (!block) return;
    const currentUserId = (BridgeRegistry.get('getCurrentUser') as (() => { _id: string } | null) | null)?.()?._id;
    block.outerHTML = renderPollBlock(poll, currentUserId);
  });

  socket.on('poll:deleted', ({ pollId }) => {
    document.querySelector(`[data-poll-id="${pollId}"]`)?.closest('.msg-group')?.remove();
  });
}


// ── POLl EDITOR MODAL ─────────────────────────────────────────
async function openPollEditor(pollId: string) {
  let poll;
  try {
    const r = await apiFetch(`${API}/api/polls/${pollId}`);
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Anket yüklenemedi', 'error'); }
    poll = await r.json();
  } catch { return toast('Anket yüklenemedi', 'error'); }

  const existing = document.getElementById('poll-editor-modal');
  if (existing) existing.remove();

  const totalVotes = poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
  const canEditOptions = totalVotes === 0;

  const optionsHtml = poll.options.map((o, i) => `
    <div class="poll-opt-row" style="display:flex;gap:8px;">
      <input class="input poll-edit-opt" value="${escHtml(o.text)}" maxlength="100"
             style="flex:1;" ${canEditOptions ? '' : 'disabled title="Oy verildiği için seçenek düzenlenemez"'}/>
      ${canEditOptions && i >= 2 ? '<button class="btn btn-secondary" onclick="this.parentElement.remove()" style="padding:6px 10px;">✕</button>' : ''}
    </div>`).join('');

  const modal = document.createElement('div');
  modal.id = 'poll-editor-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;">
      <h2 style="margin-bottom:4px;">✏️ Anketi Düzenle</h2>
      ${totalVotes > 0 ? `<p style="color:var(--yellow,#f0a732);font-size:13px;margin-bottom:12px;">⚠️ ${totalVotes} oy var — seçenekler değiştirilemez, sadece soru ve süre düzenlenebilir.</p>` : '<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Henüz oy yok — tüm alanlar düzenlenebilir.</p>'}

      <label class="settings-label">Soru</label>
      <input id="poll-edit-question" class="input" value="${escHtml(poll.question)}" maxlength="300"
             style="width:100%;margin-bottom:16px;" />

      <label class="settings-label">Seçenekler</label>
      <div id="poll-edit-options-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        ${optionsHtml}
      </div>
      ${canEditOptions ? '<button class="btn btn-secondary" onclick="addPollEditOption()" style="margin-bottom:16px;font-size:13px;">+ Seçenek Ekle</button>' : ''}

      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="poll-edit-vote-change" ${poll.allowVoteChange ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--brand);">
          Oy değiştirilebilir
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
          <span>Süre:</span>
          <select id="poll-edit-duration" class="input" style="padding:4px 8px;font-size:13px;">
            <option value="">Sınırsız</option>
            <option value="60">1 saat</option>
            <option value="360">6 saat</option>
            <option value="1440">24 saat</option>
            <option value="4320">3 gün</option>
            <option value="10080">7 gün</option>
          </select>
        </label>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('poll-editor-modal').remove()">İptal</button>
        <button class="btn" onclick="submitPollEdit('${poll._id}', ${canEditOptions})">💾 Kaydet</button>
      </div>
    </div>`;

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  document.getElementById('poll-edit-question')?.focus();
}

function addPollEditOption() {
  const list = document.getElementById('poll-edit-options-list');
  if (!list) return;
  const count = list.querySelectorAll('.poll-edit-opt').length;
  if (count >= 10) return toast('Maksimum 10 seçenek', 'error');
  const row = document.createElement('div');
  row.className = 'poll-opt-row';
  row.style.cssText = 'display:flex;gap:8px;';
  row.innerHTML = `
    <input class="input poll-edit-opt" placeholder="Seçenek ${count + 1}" maxlength="100" style="flex:1;"/>
    <button class="btn btn-secondary" onclick="this.parentElement.remove()" style="padding:6px 10px;">✕</button>`;
  list.appendChild(row);
}

async function submitPollEdit(pollId: string, canEditOptions: boolean) {
  const question = (document.getElementById('poll-edit-question') as HTMLInputElement)?.value.trim();
  if (!question) return toast('Soru gerekli', 'error');

  const body: Record<string, unknown> = {
    question,
    allowVoteChange: (document.getElementById('poll-edit-vote-change') as HTMLInputElement)?.checked || false,
  };

  const durationVal = (document.getElementById('poll-edit-duration') as HTMLSelectElement)?.value;
  if (durationVal !== undefined) body.duration = durationVal ? parseInt(durationVal) : null;

  if (canEditOptions) {
    const optInputs = document.querySelectorAll<HTMLInputElement>('#poll-edit-options-list .poll-edit-opt');
    const options = Array.from(optInputs).map(i => i.value.trim()).filter(Boolean);
    if (options.length < 2) return toast('En az 2 seçenek gerekli', 'error');
    body.options = options;
  }

  try {
    const r = await apiFetch(`${API}/api/polls/${pollId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Düzenleme başarısız', 'error'); }
    const updated = await r.json();

    document.getElementById('poll-editor-modal')?.remove();
    toast('Anket güncellendi!', 'success');

    // In-place re-render
    const block = document.querySelector(`[data-poll-id="${pollId}"]`);
    if (block) {
      const currentUserId = (BridgeRegistry.get('getCurrentUser') as (() => { _id: string } | null) | null)?.()?._id;
      block.outerHTML = renderPollBlock(updated, currentUserId);
    }

    // Notify channel via socket
    socket.emit('poll:updated', { channelId: updated.channelId, poll: updated });
  } catch (e) {
    log.error(e);
    toast('Düzenleme başarısız', 'error');
  }
}

// ── OY GERİ ALMA ──────────────────────────────────────────────
async function unvotePoll(pollId: string) {
  try {
    const r = await apiFetch(`${API}/api/polls/${pollId}/vote`, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Oy geri alınamadı', 'error'); }
    const updated = await r.json();
    const block = document.querySelector(`[data-poll-id="${pollId}"]`);
    if (block) {
      const currentUserId = (BridgeRegistry.get('getCurrentUser') as (() => { _id: string } | null) | null)?.()?._id;
      block.outerHTML = renderPollBlock(updated, currentUserId);
    }
    toast('Oy geri alındı', 'success');
  } catch (e) {
    toast('Oy geri alınamadı', 'error');
  }
}

// ── ANKETİ SİL ───────────────────────────────────────────────
async function deletePoll(pollId: string) {
  if (!confirm('Bu anketi silmek istediğine emin misin?')) return;
  try {
    const r = await apiFetch(`${API}/api/polls/${pollId}`, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Silinemedi', 'error'); }
    document.querySelector(`[data-poll-id="${pollId}"]`)?.closest('.msg-group')?.remove();
    toast('Anket silindi', 'success');
    socket.emit('poll:deleted', { pollId });
  } catch { toast('Silinemedi', 'error'); }
}

