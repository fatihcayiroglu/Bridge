// client/js/core/v42/stage.js
// ModÃ¼l: Stage el kaldÄ±rma bildirim paneli (mod onay akÄ±ÅŸÄ±)
'use strict';

const _stageHandRequests = new Map(); // userId â†’ displayName

function _addStageHandRequest(userId, displayName) {
  _stageHandRequests.set(userId, displayName);
  _renderStageHandPanel();
}
function _removeStageHandRequest(userId) {
  _stageHandRequests.delete(userId);
  _renderStageHandPanel();
}

function _renderStageHandPanel() {
  let panel = document.getElementById('stage-hand-panel');
  if (!_stageHandRequests.size) { panel?.remove(); return; }

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'stage-hand-panel';
    panel.style.cssText = `
      position:fixed;bottom:80px;right:16px;z-index:9000;
      background:var(--bg-secondary);border:1px solid var(--border);
      border-radius:12px;padding:14px;min-width:220px;max-width:280px;
      box-shadow:0 4px 20px rgba(0,0,0,.4);animation:fadeInUp2 .2s ease;`;
    document.body.appendChild(panel);
  }

  panel.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:10px;">âœ‹ El KaldÄ±ranlar (${_stageHandRequests.size})</div>
    ${[..._stageHandRequests.entries()].map(([uid, name]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(name)}</span>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn btn-primary" style="font-size:11px;padding:3px 8px;" onclick="stageApproveHand('${escHtml(uid)}')">âœ“ Davet</button>
          <button class="btn" style="font-size:11px;padding:3px 8px;" onclick="stageDenyHand('${escHtml(uid)}')">âœ•</button>
        </div>
      </div>`).join('')}`;
}

function stageApproveHand(userId) {
  const channelId = window._stageChannel?._id;
  if (!channelId || !window.socket) return;
  window.socket.emit('stage:promote', { channelId, targetUserId: userId });
  _removeStageHandRequest(userId);
  toast('KonuÅŸmacÄ±ya alÄ±ndÄ± ğŸ¤', 'success');
}

function stageDenyHand(userId) {
  const channelId = window._stageChannel?._id;
  if (!channelId || !window.socket) return;
  window.socket.emit('stage:denyHand', { channelId, targetUserId: userId });
  _removeStageHandRequest(userId);
}

document.addEventListener('DOMContentLoaded', () => {
  const _checkStageHandHook = setInterval(() => {
    if (!window.socket) return;
    clearInterval(_checkStageHandHook);
    window.socket.on('stage:handRaised', ({ userId, displayName }) => {
      const isModOrOwner = window.currentServer?.ownerId === window.me?.id;
      if (isModOrOwner) {
        _addStageHandRequest(userId, displayName);
        toast(`${displayName} konuÅŸmak istiyor âœ‹`, 'info');
      }
    });
    window.socket.on('stage:handLowered', ({ userId }) => {
      _removeStageHandRequest(userId);
    });
    window.socket.on('stage:userLeft', ({ userId }) => {
      _removeStageHandRequest(userId);
    });
  }, 500);
});

// Expose globals
window.stageApproveHand = stageApproveHand;
window.stageDenyHand    = stageDenyHand;

// â”€â”€ v65: Stage â†’ Podcast KayÄ±t Butonu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admin/owner iÃ§in stage toolbar'a "âº Kaydet" / "â¹ Durdur" butonu ekler.
// KayÄ±t durdurulunca server endpoint'i Ã§aÄŸrÄ±lÄ±r ve podcast episode oluÅŸturulur.

let _stageRecording   = false;   // aktif kayÄ±t durumu
let _stageRecStartAt  = null;    // baÅŸlangÄ±Ã§ zamanÄ± (elapsed gÃ¶stermek iÃ§in)
let _stageRecTimer    = null;    // setInterval ref

function _renderStageRecordButton() {
  const isAdmin = window.currentServer?.ownerId === window.me?.id
    || window._currentUserRole === 'admin';
  if (!isAdmin) return;

  let btn = document.getElementById('stage-record-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'stage-record-btn';
    btn.style.cssText = `
      position:fixed;top:72px;right:16px;z-index:8900;
      display:flex;align-items:center;gap:6px;
      padding:8px 14px;border-radius:20px;border:none;cursor:pointer;
      font-size:13px;font-weight:600;transition:all .2s;
      box-shadow:0 2px 10px rgba(0,0,0,.3);`;
    btn.onclick = _toggleStageRecord;
    document.body.appendChild(btn);
  }

  if (_stageRecording) {
    const elapsed = _stageRecStartAt
      ? Math.floor((Date.now() - _stageRecStartAt) / 1000)
      : 0;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    btn.style.background = '#ed4245';
    btn.style.color = '#fff';
    btn.innerHTML = `â¹ KaydÄ± Durdur <span style="font-weight:400;font-size:11px;opacity:.85;">${mm}:${ss}</span>`;
  } else {
    btn.style.background = 'var(--bg-secondary)';
    btn.style.color = 'var(--text-primary)';
    btn.innerHTML = 'âº Kaydet';
  }
}

async function _toggleStageRecord() {
  const channelId = window._stageChannel?._id;
  if (!channelId) return;

  if (_stageRecording) {
    // KaydÄ± durdur
    const title = prompt('Episode baÅŸlÄ±ÄŸÄ±:', `Stage KaydÄ± ${new Date().toLocaleDateString('tr-TR')}`);
    const description = prompt('AÃ§Ä±klama (isteÄŸe baÄŸlÄ±):', '') || '';

    try {
      const res = await apiFetch(`/api/podcast/${channelId}/record/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'KayÄ±t durdurulamadÄ±');

      _stageRecording = false;
      _stageRecStartAt = null;
      clearInterval(_stageRecTimer);
      _stageRecTimer = null;
      _renderStageRecordButton();
      toast(`âœ… Podcast episode oluÅŸturuldu: "${data.episode?.title}"`, 'success');
    } catch (err) {
      toast(`KayÄ±t durdurulamadÄ±: ${err.message}`, 'error');
    }
  } else {
    // KaydÄ± baÅŸlat
    const title = prompt('KayÄ±t baÅŸlÄ±ÄŸÄ±:', `Stage KaydÄ± ${new Date().toLocaleDateString('tr-TR')}`);
    if (!title) return;

    try {
      const res = await apiFetch(`/api/podcast/${channelId}/record/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'KayÄ±t baÅŸlatÄ±lamadÄ±');

      _stageRecording = true;
      _stageRecStartAt = Date.now();
      _stageRecTimer = setInterval(_renderStageRecordButton, 1000);
      _renderStageRecordButton();
      toast('âº KayÄ±t baÅŸladÄ±', 'info');
    } catch (err) {
      toast(`KayÄ±t baÅŸlatÄ±lamadÄ±: ${err.message}`, 'error');
    }
  }
}

// Stage gÃ¶rÃ¼ntÃ¼lendiÄŸinde kayÄ±t butonunu gÃ¶ster, ayrÄ±ldÄ±ÄŸÄ±nda kaldÄ±r
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('stage:opened', () => _renderStageRecordButton());
  document.addEventListener('stage:closed', () => {
    document.getElementById('stage-record-btn')?.remove();
    clearInterval(_stageRecTimer);
    _stageRecording = false;
    _stageRecStartAt = null;
  });
});

window.stageStartRecord = _toggleStageRecord;

