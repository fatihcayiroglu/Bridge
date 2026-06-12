// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/StagePanel.svelte
//              client/js/core/stage-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/stage.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Stage el kaldırma bildirim paneli (mod onay akışı)

import { BridgeRegistry } from './bridge-registry.js';
import { getSocket, getMe, getCurrentServer } from './globals.js';

interface SocketLike { emit(event: string, data?: unknown): void; }

declare function escHtml(s: string): string;
declare function toast(msg: string, type?: string): void;

// ── State ─────────────────────────────────────────────────────

const _stageHandRequests = new Map<string, string>(); // userId → displayName

function _addStageHandRequest(userId: string, displayName: string): void {
  _stageHandRequests.set(userId, displayName);
  _renderStageHandPanel();
}

function _removeStageHandRequest(userId: string): void {
  _stageHandRequests.delete(userId);
  _renderStageHandPanel();
}

function _renderStageHandPanel(): void {
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
          <button class="btn" style="font-size:11px;padding:3px 8px;color:var(--danger)" onclick="stageDenyHand('${escHtml(uid)}')">✕ Reddet</button>
        </div>
      </div>`).join('')}`;
}

// ── Mod fonksiyonları ─────────────────────────────────────────

export function stageApproveHand(userId: string): void {
  const server = getCurrentServer();
  (getSocket() as SocketLike | null)?.emit('stage:approve-speaker', { userId, serverId: server?._id });
  _removeStageHandRequest(userId);
}

export function stageDenyHand(userId: string): void {
  const server = getCurrentServer();
  (getSocket() as SocketLike | null)?.emit('stage:deny-speaker', { userId, serverId: server?._id });
  _removeStageHandRequest(userId);
}

export function stageRaiseHand(): void {
  const server = getCurrentServer();
  const me = getMe();
  (getSocket() as SocketLike | null)?.emit('stage:raise-hand', { serverId: server?._id, userId: me?.id });
  toast('El kaldırdın — moderatör onayı bekleniyor', 'info');
}

export function stageLowerHand(): void {
  const server = getCurrentServer();
  const me = getMe();
  (getSocket() as SocketLike | null)?.emit('stage:lower-hand', { serverId: server?._id, userId: me?.id });
}

// ── Socket event binding via BridgeRegistry ───────────────────

BridgeRegistry.register('stage:hand-raised', (data: { userId: string; displayName: string }) => {
  _addStageHandRequest(data.userId, data.displayName);
});

BridgeRegistry.register('stage:hand-lowered', (data: { userId: string }) => {
  _removeStageHandRequest(data.userId);
});

BridgeRegistry.register('stage:speaker-approved', (data: { userId: string }) => {
  const me = getMe();
  if (data.userId === me?.id) toast('✅ Konuşmacı olarak davet edildin!', 'success');
  _removeStageHandRequest(data.userId);
});

export { _addStageHandRequest, _removeStageHandRequest };
