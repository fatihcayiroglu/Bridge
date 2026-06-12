// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DraftsPanel.svelte
//              client/js/core/drafts-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/drafts.ts
// Modül: Draft mesajlar — kalıcı localStorage + otomatik kayıt + UI göstergesi

import { getCurrentChannel } from './globals.js';
import { BridgeRegistry }    from './bridge-registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DRAFT_KEY     = 'bridge_drafts_v1';
const AUTOSAVE_MS   = 800;
const MAX_DRAFT_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Types ─────────────────────────────────────────────────────────────────────

interface DraftEntry { text: string; savedAt: number; }
type DraftStore = Record<string, DraftEntry>;

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadAllDrafts(): DraftStore {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}'); }
  catch { return {}; }
}

function saveAllDrafts(obj: DraftStore): void {
  const now = Date.now();
  for (const k of Object.keys(obj)) {
    if (obj[k].savedAt && now - obj[k].savedAt > MAX_DRAFT_AGE) delete obj[k];
  }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(obj)); } catch {}
}

// ── Public API (patching BridgeRegistry) ─────────────────────────────────────

const _origSaveDraft: Function = BridgeRegistry.get('saveDraft') ?? (() => {});

function saveDraftPatched(channelId: string, text: string): void {
  if (typeof _origSaveDraft === 'function') _origSaveDraft(channelId, text);
  const all = loadAllDrafts();
  if (text?.trim()) {
    all[channelId] = { text, savedAt: Date.now() };
  } else {
    delete all[channelId];
  }
  saveAllDrafts(all);
  _updateDraftIndicator(channelId, text?.trim() ?? '');
}

const _origRestoreDraft: Function = BridgeRegistry.get('restoreDraft') ?? (() => null);

function restoreDraftPatched(channelId: string): string {
  if (typeof _origRestoreDraft === 'function') {
    const mem: string | null = _origRestoreDraft(channelId);
    if (mem) return mem;
  }
  return loadAllDrafts()[channelId]?.text ?? '';
}

// ── Draft indicator ───────────────────────────────────────────────────────────

interface IndicatorEl extends HTMLElement { _hideTimer?: ReturnType<typeof setTimeout>; }

function _updateDraftIndicator(channelId: string, text: string): void {
  let indicator = document.getElementById('draft-indicator') as IndicatorEl | null;
  if (!indicator) {
    const wrapper =
      document.getElementById('msg-input-wrapper') ??
      document.querySelector<HTMLElement>('.chat-input-wrapper');
    if (!wrapper) return;
    indicator = document.createElement('div') as IndicatorEl;
    indicator.id        = 'draft-indicator';
    indicator.className = 'draft-indicator';
    indicator.textContent = 'taslak kaydedildi';
    wrapper.appendChild(indicator);
  }
  if (text) {
    indicator.classList.add('visible');
    if (indicator._hideTimer) clearTimeout(indicator._hideTimer);
    indicator._hideTimer = setTimeout(() => (indicator as IndicatorEl).classList.remove('visible'), 2000);
  } else {
    indicator.classList.remove('visible');
  }
}

// ── Channel change: restore draft ─────────────────────────────────────────────

document.addEventListener('bridge:channel-selected', (e: Event) => {
  const inp = document.getElementById('msg-input') as HTMLTextAreaElement | null;
  const detail = (e as CustomEvent<{ channelId?: string }>).detail;
  if (!inp || !detail?.channelId) return;

  const draft: string = BridgeRegistry.call('restoreDraft', detail.channelId) ?? '';
  inp.value = draft;
  inp.style.height = 'auto';
  if (draft) {
    inp.style.height = Math.min(inp.scrollHeight, 160) + 'px';
    _updateDraftIndicator(detail.channelId, draft);
  }
});

// ── Autosave on input ─────────────────────────────────────────────────────────

let _autosaveTimer: ReturnType<typeof setTimeout> | null = null;

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('msg-input') as HTMLTextAreaElement | null;
  if (!inp) return;

  inp.addEventListener('input', () => {
    if (_autosaveTimer) clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(() => {
      const channelId = getCurrentChannel()?._id;
      if (!channelId) return;
      BridgeRegistry.call('saveDraft', channelId, inp.value);
    }, AUTOSAVE_MS);
  });

  window.addEventListener('beforeunload', () => {
    const channelId = getCurrentChannel()?._id;
    const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    if (channelId && input?.value?.trim()) {
      BridgeRegistry.call('saveDraft', channelId, input.value);
    }
  });

  // Clear draft on send
  const _origSendMsg: Function | undefined = BridgeRegistry.get('sendMessage');
  if (typeof _origSendMsg === 'function') {
    BridgeRegistry.register('sendMessage', function (...args: unknown[]) {
      const channelId = getCurrentChannel()?._id;
      if (channelId) BridgeRegistry.call('saveDraft', channelId, '');
      return _origSendMsg.apply(this, args);
    });
  }
});

// ── Debug helper ──────────────────────────────────────────────────────────────

const _bridgeDraftsDebug = {
  count:  () => Object.keys(loadAllDrafts()).length,
  list:   () => Object.entries(loadAllDrafts()).map(([k, v]) => ({
    channelId: k,
    preview:   v.text?.slice(0, 40),
    savedAt:   new Date(v.savedAt),
  })),
  clear:  () => localStorage.removeItem(DRAFT_KEY),
};

BridgeRegistry.register('_bridgeDrafts', _bridgeDraftsDebug as unknown);
BridgeRegistry.register('saveDraft',    saveDraftPatched);
BridgeRegistry.register('restoreDraft', restoreDraftPatched);

export { saveDraftPatched as saveDraft, restoreDraftPatched as restoreDraft };
