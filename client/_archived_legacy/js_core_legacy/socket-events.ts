// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SocketEventsPanel.svelte
//              client/js/core/socket-events-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/socket-events.ts
// v15+ socket event bağlantıları + status picker + stage events
//
// Sprint 81: window.loadFriends → import { loadFriends } from './friends.js'
//            window.handleStageEvent → import { handleStageEvent } from './channel-stage.js'
//            Her iki köprü globals.d.ts'ten de kaldırıldı.

import { getSocket, getCurrentServer }          from './globals.js';
import { toast }                                from './utils.js';
import { renderVoicePeer, removeVoicePeer,
         attachRemoteStream, updatePeerState }  from './voice.js';
import { openStatusPicker, loadFriends }        from './friends.js';
import { handleStageEvent }                     from './channel-stage.js';

// ── Module state ───────────────────────────────────────────────────────────────

let friendsList: Array<Record<string,unknown>> = [];
let notifPrefs: Record<string, unknown> = {};

// ── Socket events ──────────────────────────────────────────────────────────────

export function bindSocketEvents(): void {
  const socket = getSocket() as { on(ev: string, fn: (...a: unknown[]) => void): void } | null;
  if (!socket) return;

  // Thread socket events (optional hook)
  if (typeof window._bindThreadSocketEvents === 'function') {
    window._bindThreadSocketEvents();
  }

  // Timeout warning
  socket.on('error:timeout', ({ remaining }: { remaining: number }) => {
    toast(`⏱️ Susturuldunuz. ${Math.ceil(remaining / 60)} dakika kaldı.`, 'error');
  });

  // Friend request
  socket.on('friend:request:received', ({ from }: { from: { displayName: string } }) => {
    toast(`👥 ${from.displayName} sana arkadaşlık isteği gönderdi!`, 'success');
    void loadFriends();
  });

  // User status update
  socket.on('user:status', ({
    userId, status, statusText, statusEmoji,
  }: { userId: string; status: string; statusText?: string; statusEmoji?: string }) => {
    const idx = friendsList.findIndex(f => f._id === userId);
    if (idx !== -1) {
      friendsList[idx].status      = status;
      friendsList[idx].statusText  = statusText  ?? '';
      friendsList[idx].statusEmoji = statusEmoji ?? '';
    }
  });

  // Voice activity (speaking indicator on peer card)
  socket.on('voice:activity', ({ socketId, speaking }: { socketId: string; speaking: boolean }) => {
    document.querySelector<HTMLElement>(`.voice-peer[data-socket="${socketId}"]`)
      ?.classList.toggle('speaking', speaking);
  });

  // Notification preference synced from another tab/device
  socket.on('notif:pref:updated', ({ channelId, level }: { channelId: string; level: unknown }) => {
    notifPrefs[channelId] = level;
  });

  // Category events → re-load channels via CustomEvent (avoids circular import)
  const _reload = () => {
    const server = getCurrentServer() as { roles?: Array<{_id:string;name:string}> } | null;
    if (server) {
      document.dispatchEvent(new CustomEvent('bridge:reload-channels', { detail: { serverId: server._id } }));
    }
  };
  socket.on('category:created', _reload);
  socket.on('category:updated', _reload);
  socket.on('category:deleted', _reload);

  // Reaction role notifications
  socket.on('role:granted', ({ roleId, emoji }: { roleId: string; emoji: string }) => {
    const server = getCurrentServer() as { roles?: Array<{_id:string;name:string}> } | null;
    const roleName = server?.roles?.find((r) => r._id === roleId)?.name ?? roleId;
    toast(`${emoji} ${roleName} rolü verildi!`, 'success');
  });
  socket.on('role:revoked', ({ roleId, emoji }: { roleId: string; emoji: string }) => {
    const server = getCurrentServer() as { roles?: Array<{_id:string;name:string}> } | null;
    const roleName = server?.roles?.find((r) => r._id === roleId)?.name ?? roleId;
    toast(`${emoji} ${roleName} rolü alındı`, 'info');
  });
}

// ── Status picker ──────────────────────────────────────────────────────────────

export function initStatusPicker(): void {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.addEventListener('click', openStatusPicker);
}

// ── Stage socket events ────────────────────────────────────────────────────────

export function initStageSocketEvents(): void {
  const socket = getSocket() as { on(ev: string, fn: (...a: unknown[]) => void): void } | null;
  if (!socket) return;

  const stageEvents = [
    'stage:state',     'stage:userJoined', 'stage:userLeft',
    'stage:handRaise', 'stage:muteUpdate', 'stage:promoted', 'stage:demoted',
    'stage:speaking',  'stage:topicUpdate', 'stage:liveUpdate',
  ];

  for (const ev of stageEvents) {
    socket.on(ev, (data: unknown) => {
      handleStageEvent(ev, data as Record<string, unknown>);
    });
  }
}

// ── Bridge app interface (WebRTC bridge) ───────────────────────────────────────

export function bridgeAppInterface(): {
  renderVoicePeer: typeof renderVoicePeer;
  removeVoicePeer: typeof removeVoicePeer;
  attachRemoteStream: typeof attachRemoteStream;
  updatePeerState: typeof updatePeerState;
  toast: typeof toast;
} {
  return { renderVoicePeer, removeVoicePeer, attachRemoteStream, updatePeerState, toast };
}
