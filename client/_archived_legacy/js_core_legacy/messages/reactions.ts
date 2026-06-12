// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ReactionsPanel.svelte
//              client/js/core/reactions-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/messages/reactions.ts
// Mesaj reaksiyon UI yardımcıları
// Sprint 49: .js → .ts (tam TypeScript geçişi)

import { getMe, getCurrentChannel, getSocket } from '../globals.js';
import { escHtml } from '../utils.js';

type Reactions = Record<string, string[]>;

export function renderReactionsHtml(msgId: string, reactions: Reactions): string {
  const me      = getMe();
  const entries = Object.entries(reactions);

  if (!entries.length) {
    return `<div class="msg-reactions" id="reactions-${msgId}"><button class="add-reaction-btn" onclick="quickReact('${msgId}')">😊+</button></div>`;
  }

  const pills = entries.map(([emoji, users]) => {
    const reacted = me ? users.includes(me.id) : false;
    return `<button class="reaction-pill${reacted ? ' reacted' : ''}" onclick="reactToMessage('${escHtml(msgId)}', '${escHtml(emoji)}')" title="${users.length} reaction(s)">${emoji} ${users.length}</button>`;
  }).join('');

  return `<div class="msg-reactions" id="reactions-${msgId}">${pills}<button class="add-reaction-btn" onclick="quickReact('${escHtml(msgId)}')">😊+</button></div>`;
}

export function reactToMessage(msgId: string, emoji: string): void {
  const channel = getCurrentChannel();
  if (!channel) return;
  const socket  = getSocket();
  socket?.emit('message:react', { messageId: msgId, channelId: channel._id, emoji });
}

export function quickReact(msgId: string): void {
  const QUICK = ['👍', '👎', '❤️', '😂', '😮', '😢', '🎉', '🔥'];
  document.getElementById('quick-react-picker')?.remove();

  const picker = document.createElement('div');
  picker.id        = 'quick-react-picker';
  picker.className = 'quick-react-picker';
  picker.innerHTML = QUICK.map(e =>
    `<button onclick="reactToMessage('${escHtml(msgId)}', '${e}'); document.getElementById('quick-react-picker')?.remove()">${e}</button>`
  ).join('');

  document.getElementById(`reactions-${msgId}`)?.appendChild(picker);
  setTimeout(() => picker.remove(), 5000);
}
