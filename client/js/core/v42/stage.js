// client/js/core/v42/stage.js
// Modül: Stage el kaldırma bildirim paneli (mod onay akışı)
'use strict';
import { getSocket, getMe, getCurrentServer } from '../globals.js';

const _stageHandRequests = new Map(); // userId → displayName

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
    <div style="font-weight:600;font-size:13px;margin-bottom:10px;">✋ El Kaldıranlar (${_stageHandRequests.size})</div>
    ${[..._stageHandRequests.entries()].map(([uid, name]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(name)}</span>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn btn-primary" style="font-size:11px;padding:3px 8px;" onclick="stageApproveHand('${escHtml(uid)}')">✓ Davet</button>
          <button class="btn" style="font-size:11px;padding:3px 8px;" onclick="stageDenyHand('${escHtml(uid)}')">✕</button>
        </div>
      </div>`).join('')}`;
}

function stageApproveHand(userId) {
  const channelId = window._stageChannel?._id;
  if (!channelId || !getSocket()) return;
  getSocket().emit('stage:promote', { channelId, targetUserId: userId });
  _removeStageHandRequest(userId);
  toast('Konuşmacıya alındı 🎤', 'success');
}

function stageDenyHand(userId) {
  const channelId = window._stageChannel?._id;
  if (!channelId || !getSocket()) return;
  getSocket().emit('stage:denyHand', { channelId, targetUserId: userId });
  _removeStageHandRequest(userId);
}

document.addEventListener('DOMContentLoaded', () => {
  const _checkStageHandHook = setInterval(() => {
    if (!getSocket()) return;
    clearInterval(_checkStageHandHook);
    getSocket().on('stage:handRaised', ({ userId, displayName }) => {
      const isModOrOwner = getCurrentServer()?.ownerId === getMe()?.id;
      if (isModOrOwner) {
        _addStageHandRequest(userId, displayName);
        toast(`${displayName} konuşmak istiyor ✋`, 'info');
      }
    });
    getSocket().on('stage:handLowered', ({ userId }) => {
      _removeStageHandRequest(userId);
    });
    getSocket().on('stage:userLeft', ({ userId }) => {
      _removeStageHandRequest(userId);
    });
  }, 500);
});

// Expose globals

// ── v65: Stage → Podcast Kayıt Butonu ────────────────────────────────────
// Admin/owner için stage toolbar'a "⏺ Kaydet" / "⏹ Durdur" butonu ekler.
// Kayıt durdurulunca server endpoint'i çağrılır ve podcast episode oluşturulur.

let _stageRecording   = false;   // aktif kayıt durumu
let _stageRecStartAt  = null;    // başlangıç zamanı (elapsed göstermek için)
let _stageRecTimer    = null;    // setInterval ref

function _renderStageRecordButton() {
  const isAdmin = getCurrentServer()?.ownerId === getMe()?.id
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
    btn.innerHTML = `⏹ Kaydı Durdur <span style="font-weight:400;font-size:11px;opacity:.85;">${mm}:${ss}</span>`;
  } else {
    btn.style.background = 'var(--bg-secondary)';
    btn.style.color = 'var(--text-primary)';
    btn.innerHTML = '⏺ Kaydet';
  }
}

async function _toggleStageRecord() {
  const channelId = window._stageChannel?._id;
  if (!channelId) return;

  if (_stageRecording) {
    // Kaydı durdur
    const title = prompt('Episode başlığı:', `Stage Kaydı ${new Date().toLocaleDateString('tr-TR')}`);
    const description = prompt('Açıklama (isteğe bağlı):', '') || '';

    try {
      const res = await apiFetch(`/api/podcast/${channelId}/record/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kayıt durdurulamadı');

      _stageRecording = false;
      _stageRecStartAt = null;
      clearInterval(_stageRecTimer);
      _stageRecTimer = null;
      _renderStageRecordButton();
      toast(`✅ Podcast episode oluşturuldu: "${data.episode?.title}"`, 'success');
    } catch (err) {
      toast(`Kayıt durdurulamadı: ${err.message}`, 'error');
    }
  } else {
    // Kaydı başlat
    const title = prompt('Kayıt başlığı:', `Stage Kaydı ${new Date().toLocaleDateString('tr-TR')}`);
    if (!title) return;

    try {
      const res = await apiFetch(`/api/podcast/${channelId}/record/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kayıt başlatılamadı');

      _stageRecording = true;
      _stageRecStartAt = Date.now();
      _stageRecTimer = setInterval(_renderStageRecordButton, 1000);
      _renderStageRecordButton();
      toast('⏺ Kayıt başladı', 'info');
    } catch (err) {
      toast(`Kayıt başlatılamadı: ${err.message}`, 'error');
    }
  }
}

// Stage görüntülendiğinde kayıt butonunu göster, ayrıldığında kaldır
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('stage:opened', () => _renderStageRecordButton());
  document.addEventListener('stage:closed', () => {
    document.getElementById('stage-record-btn')?.remove();
    clearInterval(_stageRecTimer);
    _stageRecording = false;
    _stageRecStartAt = null;
  });
});

