// client/js/core/v43/drafts.js
// Modül: Draft mesajlar — kalıcı localStorage + otomatik kayıt + UI göstergesi
'use strict';
import { getCurrentChannel } from '../globals.js';

const DRAFT_KEY      = 'bridge_drafts_v1';
const AUTOSAVE_MS    = 800;  // input durgunluk süresi sonrası kaydet
const MAX_DRAFT_AGE  = 7 * 24 * 60 * 60 * 1000; // 7 gün — eski taslakları sil

// ── Depolama ───────────────────────────────────────────────
function loadAllDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}

function saveAllDrafts(obj) {
  // Eski taslakları temizle
  const now = Date.now();
  for (const [k, v] of Object.entries(obj)) {
    if (v.savedAt && (now - v.savedAt) > MAX_DRAFT_AGE) delete obj[k];
  }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(obj)); } catch {}
}

// ── Public API ─────────────────────────────────────────────
const _origSaveDraft = window.saveDraft;
window.saveDraft = function(channelId, text) {
  if (typeof _origSaveDraft === 'function') _origSaveDraft(channelId, text);
  const all = loadAllDrafts();
  if (text?.trim()) {
    all[channelId] = { text, savedAt: Date.now() };
  } else {
    delete all[channelId];
  }
  saveAllDrafts(all);
  _updateDraftIndicator(channelId, text?.trim() || '');
};

const _origRestoreDraft = window.restoreDraft;
window.restoreDraft = function(channelId) {
  if (typeof _origRestoreDraft === 'function') {
    const mem = _origRestoreDraft(channelId);
    if (mem) return mem;
  }
  const all = loadAllDrafts();
  return all[channelId]?.text || '';
};

// ── Draft indicator göster/gizle ────────────────────────────
function _updateDraftIndicator(channelId, text) {
  let indicator = document.getElementById('draft-indicator');
  if (!indicator) {
    const wrapper = document.getElementById('msg-input-wrapper')
      || document.querySelector('.chat-input-wrapper');
    if (!wrapper) return;
    indicator = document.createElement('div');
    indicator.id = 'draft-indicator';
    indicator.className = 'draft-indicator';
    indicator.textContent = 'taslak kaydedildi';
    wrapper.appendChild(indicator);
  }
  if (text) {
    indicator.classList.add('visible');
    clearTimeout(indicator._hideTimer);
    indicator._hideTimer = setTimeout(() => indicator.classList.remove('visible'), 2000);
  } else {
    indicator.classList.remove('visible');
  }
}

// ── Kanal değişimi: taslağı geri yükle ─────────────────────
document.addEventListener('bridge:channel-selected', (e) => {
  const inp = document.getElementById('msg-input');
  if (!inp || !e.detail?.channelId) return;
  const draft = window.restoreDraft(e.detail.channelId) || '';
  inp.value = draft;
  inp.style.height = 'auto';
  if (draft) {
    inp.style.height = Math.min(inp.scrollHeight, 160) + 'px';
    _updateDraftIndicator(e.detail.channelId, draft);
  }
});

// ── Otomatik kayıt: input durgunluğu sonrası ────────────────
let _autosaveTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('msg-input');
  if (!inp) return;

  inp.addEventListener('input', () => {
    clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(() => {
      const channelId = getCurrentChannel()?._id;
      if (!channelId) return;
      window.saveDraft(channelId, inp.value);
    }, AUTOSAVE_MS);
  });

  // Sayfa kapatılırken kaydet
  window.addEventListener('beforeunload', () => {
    const channelId = getCurrentChannel()?._id;
    const inp       = document.getElementById('msg-input');
    if (channelId && inp?.value?.trim()) {
      window.saveDraft(channelId, inp.value);
    }
  });

  // Mesaj gönderilince taslağı sil
  const _origSendMsg = window.sendMessage;
  if (typeof _origSendMsg === 'function') {
    window.sendMessage = function() {
      const channelId = getCurrentChannel()?._id;
      if (channelId) window.saveDraft(channelId, '');
      return _origSendMsg.apply(this, arguments);
    };
  }
});

// Kaç taslak var — debug
window._bridgeDrafts = {
  count:  () => Object.keys(loadAllDrafts()).length,
  list:   () => Object.entries(loadAllDrafts()).map(([k, v]) => ({ channelId: k, preview: v.text?.slice(0, 40), savedAt: new Date(v.savedAt) })),
  clear:  () => { localStorage.removeItem(DRAFT_KEY); console.log('[Drafts] Tüm taslaklar silindi'); },
};
